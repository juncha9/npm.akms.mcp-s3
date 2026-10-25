import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadS3Profile } from "../src/profile";
import { S3Store } from "../src/store";
import { fixture } from "./fixture";

describe("S3 wire protocol and storage policy", () => {
    let remote: Awaited<ReturnType<typeof fixture>>;
    let stores: S3Store[];
    let local: string;
    const store = (env: Record<string, string> = {}) => { const value = new S3Store(loadS3Profile({ ...remote.env, S3_LOCAL_ROOT: local, ...env })!); stores.push(value); return value; };
    beforeEach(async () => { remote = await fixture(); stores = []; local = await fs.mkdtemp(path.join(os.tmpdir(), "akms-s3-")); });
    afterEach(async () => { for(const value of stores) value.close(); await remote.close(); await fs.rm(local, { recursive: true, force: true }); });

    it("creates, reads, stats, conditionally replaces and deletes with version identifiers", async () => {
        const s3 = store();
        const created = await s3.write("dir/hello.txt", "hello", { metadata: { owner: "test" } });
        expect(created).toMatchObject({ outcome: "applied", bytes: 5, version_id: "version-1" });
        expect(remote.requests[0].headers["if-none-match"]).toBe("*");
        expect(await s3.read("dir/hello.txt")).toMatchObject({ text: "hello", truncated: false });
        expect(await s3.stat("dir/hello.txt")).toMatchObject({ size: 5, metadata: { owner: "test" } });
        await expect(s3.write("dir/hello.txt", "collision")).rejects.toMatchObject({ details: { code: "Conflict", outcome: "not_applied", http_status: 412 } });
        await expect(s3.write("dir/hello.txt", "stale", { mode: "replace", if_match: '"stale"' })).rejects.toMatchObject({ details: { code: "Conflict" } });
        const replaced = await s3.write("dir/hello.txt", "replacement", { mode: "replace", if_match: created.etag });
        expect(remote.requests.at(-1)?.headers["if-match"]).toBe(created.etag);
        expect(await s3.delete("dir/hello.txt", { if_match: replaced.etag })).toMatchObject({ outcome: "applied", delete_marker: true, version_id: "delete-version" });
        expect(remote.requests.at(-1)?.query.has("versionId")).toBe(false);
        await expect(s3.stat("dir/hello.txt")).rejects.toMatchObject({ details: { code: "NotFound" } });
    });
    it("makes upsert explicit and treats * as a literal delete key", async () => {
        const s3 = store(); remote.put("*", "literal"); remote.put("keep", "keep");
        await s3.write("keep", "new", { mode: "upsert" });
        expect(remote.requests.at(-1)?.headers["if-none-match"]).toBeUndefined();
        await s3.delete("*");
        expect([...remote.objects.keys()]).toEqual(["keep"]);
    });
    it("does not dispatch invalid or read-only mutations", async () => {
        const s3 = store({ S3_PREFIX: "allowed/", S3_READONLY: "true" });
        await expect(s3.write("allowed/key", "x")).rejects.toMatchObject({ details: { code: "ReadOnly", outcome: "not_applied" } });
        await expect(s3.delete("outside/key")).rejects.toMatchObject({ details: { code: "OutsidePrefix", outcome: "not_applied" } });
        await expect(s3.upload("allowed/file", "missing")).rejects.toMatchObject({ details: { code: "ReadOnly" } });
        expect(remote.requests).toHaveLength(0);
    });
    it("preserves unusual keys all the way to the HTTP request", async () => {
        const s3 = store();
        const key = "a/../ spaces//%2f\\unicode-한글";
        await s3.write(key, "literal");
        expect(remote.requests[0].key).toBe(key);
        expect(await s3.read(key)).toMatchObject({ text: "literal" });
    });
    it("decodes only declared S3 list wire encoding, once, including XML-unsafe characters", async () => {
        const keys = ["literal%2F", "special&<>+ spaces", "unicode-한글", "control-\u0001"];
        for(const key of keys) remote.put(key, "x");
        const listed = await store().list({ recursive: true });
        expect(listed.objects.map((item) => item.key).sort()).toEqual(keys.sort());
        expect(remote.requests[0].query.get("encoding-type")).toBe("url");
    });
    it("paginates objects and prefixes without losing results; binds cursors to queries and sessions", async () => {
        const s3 = store({ S3_PREFIX: "scope/", S3_MAX_LIST_ITEMS: "2" });
        for(const key of ["scope/a", "scope/b/child", "scope/c", "other/z"]) remote.put(key, "x");
        const page = await s3.list();
        expect(page.objects.map((item) => item.key)).toEqual(["scope/a"]);
        expect(page.prefixes).toEqual(["scope/b/"]);
        expect(page.cursor).toBeTruthy();
        expect((await s3.list({ cursor: page.cursor! })).objects.map((item) => item.key)).toEqual(["scope/c"]);
        await expect(s3.list({ cursor: page.cursor!, recursive: true })).rejects.toMatchObject({ details: { code: "InvalidCursor" } });
        await expect(store({ S3_PREFIX: "scope/", S3_MAX_LIST_ITEMS: "2" }).list({ cursor: page.cursor! })).rejects.toMatchObject({ details: { code: "InvalidCursor" } });
        await expect(s3.list({ cursor: page.cursor! + "tampered" })).rejects.toMatchObject({ details: { code: "InvalidCursor" } });
        await expect(s3.list({ prefix: "" })).rejects.toMatchObject({ details: { code: "OutsidePrefix" } });
    });
    it("truncates text at UTF-8 boundaries and rejects binary or compressed previews", async () => {
        const s3 = store();
        remote.put("text", "A€BC");
        expect(await s3.read("text", { max_bytes: 3 })).toMatchObject({ text: "A", bytes: 1, truncated: true });
        expect(await s3.read("text", { max_bytes: 4 })).toMatchObject({ text: "A€", bytes: 4, truncated: true });
        remote.put("invalid", Buffer.from([0xff, 0x00]));
        remote.put("binary", "looks text", "application/octet-stream");
        remote.put("compressed", "compressed", "text/plain", "gzip");
        for(const key of ["invalid", "binary", "compressed"]) await expect(s3.read(key)).rejects.toMatchObject({ details: { code: "BinaryObject" } });
    });
    it("bounds previews even when a compatible server ignores Range", async () => {
        const s3 = store();
        remote.intercept((request, response) => {
            if(request.method !== "GET") return false;
            response.writeHead(200, { "content-type": "text/plain", "content-length": 100000 }); response.end("x".repeat(100000)); return true;
        });
        expect(await s3.read("big", { max_bytes: 20 })).toMatchObject({ text: "x".repeat(20), bytes: 20, truncated: true });
    });
    it("reads and transfers empty objects", async () => {
        const s3 = store();
        const object = remote.put("empty", "");
        expect(await s3.read("empty", { if_match: object.etag })).toMatchObject({ text: "", bytes: 0, truncated: false });
        await fs.writeFile(path.join(local, "empty"), "");
        expect(await s3.upload("empty-upload", "empty")).toMatchObject({ outcome: "applied", bytes: 0 });
        expect(await s3.download("empty", "empty-download")).toMatchObject({ bytes: 0 });
    });
    it("allows only one concurrent create for a new key", async () => {
        const s3 = store();
        const results = await Promise.allSettled([s3.write("race", "first"), s3.write("race", "second")]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
    it("preserves a UTF-8 BOM and its byte count", async () => {
        remote.put("bom", "\ufefftext");
        expect(await store().read("bom")).toMatchObject({ text: "\ufefftext", bytes: 7, truncated: false });
    });
    it("rejects incorrect response checksums and removes the partial download", async () => {
        remote.intercept((_request, response) => {
            response.writeHead(200, { "content-type": "text/plain", "content-length": 4, "x-amz-checksum-crc32": "AAAAAA==" });
            response.end("test"); return true;
        });
        const s3 = store({ S3_CHECKSUM_MODE: "WHEN_SUPPORTED" });
        await expect(s3.read("bad-checksum")).rejects.toBeDefined();
        await expect(s3.download("bad-checksum", "partial")).rejects.toBeDefined();
        expect(await fs.readdir(local)).toEqual([]);
    });
    it("retains accepted mutation identifiers when the local upload source changes", async () => {
        await fs.writeFile(path.join(local, "source"), "before");
        remote.intercept(async (request) => {
            if(request.method === "PUT") await fs.utimes(path.join(local, "source"), new Date(), new Date(Date.now() + 60000));
            return false;
        });
        expect(await store().upload("changed", "source")).toMatchObject({ outcome: "applied", version_id: "version-1", warning: expect.stringContaining("changed") });
    });
    it("checks credentials and listing without writes or HeadBucket", async () => {
        const phases: string[] = [];
        expect(await store({ S3_PREFIX: "scope/" }).check((phase) => phases.push(phase))).toMatchObject({ connected: true, checked: ["credentials", "list"] });
        expect(phases).toHaveLength(2);
        expect(remote.requests).toHaveLength(1);
        expect(remote.requests[0]).toMatchObject({ method: "GET" });
        expect(remote.requests[0].query.get("max-keys")).toBe("1");
        expect(remote.requests[0].query.get("prefix")).toBe("scope/");
    });
    it("never retries a mutation or falls back after unsupported conditions", async () => {
        remote.intercept((_request, response) => { response.writeHead(501, { "content-type": "application/xml" }); response.end("<Error><Code>NotImplemented</Code></Error>"); return true; });
        await expect(store().write("new", "body")).rejects.toMatchObject({ details: { code: "Unsupported", outcome: "not_applied" } });
        expect(remote.requests).toHaveLength(1);
        expect(remote.requests[0].headers["if-none-match"]).toBe("*");
    });
    it("reports a lost mutation response as unknown and sends only once", async () => {
        remote.intercept((_request, response) => { response.destroy(); return true; });
        await expect(store().write("new", "body")).rejects.toMatchObject({ details: { outcome: "unknown" } });
        expect(remote.requests).toHaveLength(1);
    });
    it("allows bounded retries for reads", async () => {
        remote.put("retry", "value");
        remote.intercept((_request, response) => { if(remote.requests.length > 1) return false; response.writeHead(503, { "content-type": "application/xml" }); response.end("<Error><Code>SlowDown</Code></Error>"); return true; });
        expect(await store().stat("retry")).toMatchObject({ size: 5 });
        expect(remote.requests).toHaveLength(2);
    });
    it("cancels queued operations before dispatch, and bounds active requests", async () => {
        const s3 = store({ S3_MAX_CONCURRENCY: "1", S3_REQUEST_TIMEOUT_MS: "200" });
        remote.intercept(() => true);
        const first = s3.stat("hold").catch((error) => error);
        const controller = new AbortController();
        const second = s3.write("queued", "body", {}, controller.signal);
        controller.abort();
        await expect(second).rejects.toMatchObject({ details: { code: "Cancelled", outcome: "not_applied" } });
        expect(await first).toMatchObject({ details: { code: "Cancelled" } });
        expect(remote.requests).toHaveLength(1);
    });
    it.each(["WHEN_REQUIRED", "WHEN_SUPPORTED"])("streams uploads and downloads with checksum mode %s", async (mode) => {
        const s3 = store({ S3_CHECKSUM_MODE: mode });
        const content = Buffer.from(Array.from({ length: 102400 }, (_, index) => index % 256));
        await fs.writeFile(path.join(local, "source.bin"), content);
        const uploaded = await s3.upload("file", "source.bin");
        expect(uploaded).toMatchObject({ outcome: "applied", bytes: content.length });
        expect(remote.objects.get("file")?.body).toEqual(content);
        expect(await s3.download("file", "download.bin", { if_match: uploaded.etag })).toMatchObject({ bytes: content.length });
        expect(await fs.readFile(path.join(local, "download.bin"))).toEqual(content);
        await expect(s3.download("file", "download.bin")).rejects.toMatchObject({ details: { code: "FileExists" } });
        expect((await fs.readdir(local)).some((name) => name.endsWith(".tmp"))).toBe(false);
    });
    it("rejects escaped and credential paths before making requests", async () => {
        const s3 = store();
        await fs.mkdir(path.join(local, ".aws"));
        await fs.writeFile(path.join(local, ".aws", "credentials"), "secret");
        for(const input of ["../escape", ".aws/credentials", ".akms/mcp/registry.json", ".mcp.json", "private.pem"]) {
            await expect(s3.upload("file", input)).rejects.toBeDefined();
            await expect(s3.download("file", input)).rejects.toBeDefined();
        }
        expect(remote.requests).toHaveLength(0);
    });
    it("rejects directory junction escapes", async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "akms-s3-outside-"));
        try {
            await fs.writeFile(path.join(outside, "source"), "outside");
            await fs.symlink(outside, path.join(local, "escape"), process.platform === "win32" ? "junction" : "dir");
            const s3 = store();
            await expect(s3.upload("file", "escape/source")).rejects.toMatchObject({ details: { code: "OutsideLocalRoot" } });
            await expect(s3.download("file", "escape/download")).rejects.toMatchObject({ details: { code: "OutsideLocalRoot" } });
            expect(remote.requests).toHaveLength(0);
        } finally { await fs.rm(path.join(local, "escape"), { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
    });
    it("enforces transfer byte counts and cleans partial files", async () => {
        const s3 = store({ S3_MAX_TRANSFER_BYTES: "5" });
        await fs.writeFile(path.join(local, "large"), "123456");
        await expect(s3.upload("large", "large")).rejects.toMatchObject({ details: { code: "LimitExceeded", outcome: "not_applied" } });
        remote.intercept((_request, response) => { response.writeHead(200); response.write("123"); response.end("456"); return true; });
        await expect(s3.download("large", "partial")).rejects.toMatchObject({ details: { code: "LimitExceeded" } });
        expect(await fs.readdir(local)).toEqual(["large"]);
    });
    it("cleans a timed-out streaming download without committing it", async () => {
        remote.intercept((_request, response) => { response.writeHead(200, { "content-type": "application/octet-stream" }); response.write("partial"); return true; });
        await expect(store({ S3_TRANSFER_TIMEOUT_MS: "100" }).download("file", "partial")).rejects.toMatchObject({ details: { code: "Cancelled" } });
        expect(await fs.readdir(local)).toEqual([]);
    });
    it("does not overwrite a destination created while downloading", async () => {
        remote.intercept(async (_request, response) => { await fs.writeFile(path.join(local, "race"), "keep"); response.writeHead(200); response.end("replace"); return true; });
        await expect(store().download("file", "race")).rejects.toMatchObject({ details: { code: "FileExists" } });
        expect(await fs.readFile(path.join(local, "race"), "utf8")).toBe("keep");
        expect(await fs.readdir(local)).toEqual(["race"]);
    });
});
