import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function run(script: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|S3_|NODE_OPTIONS$)/i.test(key)));
    return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...env, AWS_EC2_METADATA_DISABLED: "true" },
        encoding: "utf8", timeout: 20000, windowsHide: true,
    }).trim();
}

describe("S3 runtime allocation", () => {
    it("honours close and cancellation during cold loading without interrupting another request", () => {
        const entry = new URL("../lib/index.js", import.meta.url).href;
        const fixture = new URL("./fixture.ts", import.meta.url).href;
        expect(run(`
            import assert from "node:assert/strict";
            import { createRequire } from "node:module";
            import { sep } from "node:path";
            const require = createRequire(process.cwd() + "/package.json");
            const api = await import(${JSON.stringify(entry)});
            const { fixture } = await import(${JSON.stringify(fixture)});
            const remote = await fixture();
            remote.put("one", "content");
            const profile = api.loadS3Profile(remote.env);
            const closing = new api.S3Store(profile);
            const active = new api.S3Store(profile);
            try {
                assert.equal(Object.keys(require.cache).some(file => file.includes(sep + "client-s3" + sep)), false);
                const stopped = closing.stat("one");
                closing.close();
                const controller = new AbortController();
                const cancelled = active.stat("one", controller.signal);
                controller.abort();
                const survivor = active.stat("one");
                const results = await Promise.allSettled([stopped, cancelled, survivor]);
                assert(results.slice(0, 2).every(result => result.status === "rejected" && result.reason.details.code === "Cancelled"));
                assert.equal(results[2].status, "fulfilled");
                assert.equal(results[2].value.size, 7);
                assert.equal(remote.requests.length, 1);
                console.log("passed");
            } finally { closing.close(); active.close(); await remote.close(); }
        `)).toBe("passed");
    }, 25000);

    it.each(["js", "cjs"])("keeps %s startup light and shares safe initialization across requests", (extension) => {
        const entry = new URL(`../lib/index.${extension}`, import.meta.url).href;
        const fixture = new URL("./fixture.ts", import.meta.url).href;
        expect(run(`
            import assert from "node:assert/strict";
            import { createRequire } from "node:module";
            import { sep } from "node:path";
            const require = createRequire(process.cwd() + "/package.json");
            const loaded = name => Object.keys(require.cache).some(file => file.includes(sep + name + sep));
            const api = await import(${JSON.stringify(entry)});
            assert.equal(loaded("client-s3"), false);
            assert.equal(loaded("credential-providers"), false);
            const { fixture } = await import(${JSON.stringify(fixture)});
            const remote = await fixture();
            const profile = api.loadS3Profile(remote.env);
            const store = new api.S3Store(profile);
            const instance = api.createS3McpServer(remote.env);
            try {
                assert.equal(store.info().configured, true);
                assert.equal(loaded("client-s3"), false);
                assert.throws(() => new api.S3Store({ ...profile, caFile: "missing-ca-file-for-memory-test" }), api.ConfigError);
                const huge = "가".repeat(1024 * 1024);
                const originalFrom = Buffer.from;
                let copied = false;
                Buffer.from = function(value, ...args) {
                    if(value === huge) copied = true;
                    return originalFrom(value, ...args);
                };
                try {
                    await assert.rejects(store.write("large", huge), error => error.details.code === "LimitExceeded");
                } finally { Buffer.from = originalFrom; }
                assert.equal(copied, false);
                assert.equal(loaded("client-s3"), false);
                assert.equal(remote.requests.length, 0);
                remote.put("one", "content");
                const requests = await Promise.all(Array.from({ length: 8 }, () => store.stat("one")));
                assert(requests.every(result => result.size === 7));
                assert.equal(remote.requests.length, 8);
                assert.equal(loaded("client-s3"), true);
                assert.equal(loaded("credential-providers"), false);
                const closing = new api.S3Store(profile);
                const first = closing.stat("one");
                const second = closing.stat("one");
                closing.close();
                const results = await Promise.allSettled([first, second]);
                assert(results.every(result => result.status === "rejected" && result.reason.details.code === "Cancelled"));
                await assert.rejects(closing.stat("one"));
                assert.equal(remote.requests.length, 8);
                assert.equal((await store.stat("one")).size, 7);
                console.log("passed");
            } finally { store.close(); await instance.shutdown(); await remote.close(); }
        `)).toBe("passed");
    }, 25000);

    it.each(["default", "profile"])("loads %s credentials only on first use with isolated fixture credentials", (auth) => {
        const entry = new URL("../lib/index.js", import.meta.url).href;
        const fixture = new URL("./fixture.ts", import.meta.url).href;
        expect(run(`
            import assert from "node:assert/strict";
            import fs from "node:fs/promises";
            import os from "node:os";
            import path from "node:path";
            import { createRequire } from "node:module";
            const require = createRequire(process.cwd() + "/package.json");
            const loaded = () => Object.keys(require.cache).some(file => file.includes(path.sep + "credential-providers" + path.sep));
            const api = await import(${JSON.stringify(entry)});
            const { fixture } = await import(${JSON.stringify(fixture)});
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), "s3-auth-memory-"));
            const remote = await fixture();
            let store;
            try {
                process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(directory, "credentials");
                process.env.AWS_CONFIG_FILE = path.join(directory, "config");
                process.env.AWS_PROFILE = "memory";
                await fs.writeFile(process.env.AWS_SHARED_CREDENTIALS_FILE, "[memory]\\naws_access_key_id=fixture-access\\naws_secret_access_key=fixture-secret\\n");
                await fs.writeFile(process.env.AWS_CONFIG_FILE, "[profile memory]\\nregion=us-east-1\\n");
                const auth = ${JSON.stringify(auth)};
                const env = { ...remote.env, S3_AUTH: auth, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, S3_PROFILE: auth === "profile" ? "memory" : undefined };
                store = new api.S3Store(api.loadS3Profile(env));
                assert.equal(loaded(), false);
                assert.equal((await store.check()).connected, true);
                assert.equal(loaded(), true);
                assert.equal(remote.requests.length, 1);
                console.log("passed");
            } finally {
                store?.close(); await remote.close();
                assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
                assert(path.basename(directory).startsWith("s3-auth-memory-"));
                await fs.rm(directory, { recursive: true, force: true });
            }
        `)).toBe("passed");
    }, 25000);
});
