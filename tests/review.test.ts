import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadS3Profile } from "../src/profile";
import { S3Store } from "../src/store";
import { runTargetConfigCommand as runConfigCommand } from "../src/modules/manage";
import { createJsonFileTarget } from "../src/modules/manage/targets/json-file";
import type { ConfigTarget, McpServerEntry } from "../src/_types";
import { fixture } from "./fixture";

let remote: Awaited<ReturnType<typeof fixture>>;
let directory: string;
let stores: S3Store[];
beforeEach(async () => {
    remote = await fixture();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "akms-s3-review-"));
    stores = [];
});
afterEach(async () => {
    vi.restoreAllMocks();
    for(const store of stores) store.close();
    await remote.close();
    const relative = path.relative(os.tmpdir(), directory);
    if(!relative.startsWith("akms-s3-review-") || relative.includes(path.sep)) throw new Error("Unexpected cleanup target");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
function store() {
    const value = new S3Store(loadS3Profile({ ...remote.env, S3_LOCAL_ROOT: directory })!);
    stores.push(value);
    return value;
}

describe("review regressions", () => {
    it("marks a short partial preview as truncated even below the requested byte cap", async () => {
        remote.intercept((_request, response) => {
            response.writeHead(206, { "content-type": "text/plain", "content-range": "bytes 0-2/10", "content-length": 3 });
            response.end("abc"); return true;
        });
        expect(await store().read("partial")).toMatchObject({ text: "abc", bytes: 3, truncated: true });
    });
    it.each(["bytes 3-5/10", "bytes 0-2/2", "not-a-range"])("rejects an invalid preview range %s", async (range) => {
        remote.intercept((_request, response) => {
            response.writeHead(206, { "content-type": "text/plain", "content-range": range, "content-length": 3 });
            response.end("abc"); return true;
        });
        await expect(store().read("partial")).rejects.toMatchObject({ details: { code: "InvalidResponse" } });
    });
    it("refuses to save a partial response as a complete download", async () => {
        remote.intercept((_request, response) => {
            response.writeHead(206, { "content-range": "bytes 0-2/10", "content-length": 3 });
            response.end("abc"); return true;
        });
        await expect(store().download("partial", "download")).rejects.toMatchObject({ details: { code: "InvalidResponse" } });
        expect(await fs.readdir(directory)).toEqual([]);
    });
    it("does not commit a download cancelled during fsync", async () => {
        remote.put("file", "complete");
        const controller = new AbortController();
        const original = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await original(...args);
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); controller.abort(); });
            return handle;
        });
        await expect(store().download("file", "cancelled", {}, controller.signal)).rejects.toMatchObject({ details: { code: "Cancelled" } });
        expect(await fs.readdir(directory)).toEqual([]);
    });
    it("classifies MCP-style string cancellation reasons before and after dispatch", async () => {
        const cancelled = new AbortController();
        cancelled.abort("private cancellation reason");
        await expect(store().write("before", "text", {}, cancelled.signal)).rejects.toMatchObject({ details: { code: "Cancelled", outcome: "not_applied" } });
        const active = new AbortController();
        let started!: () => void;
        const requestStarted = new Promise<void>((resolve) => { started = resolve; });
        remote.intercept(() => { started(); return true; });
        const result = store().write("after", "text", {}, active.signal).catch((error) => error);
        await requestStarted;
        active.abort("private cancellation reason");
        const error = await result;
        expect(error).toMatchObject({ details: { code: "Cancelled", outcome: "unknown" } });
        expect(JSON.stringify(error.details)).not.toContain("private cancellation reason");
        expect(remote.requests).toHaveLength(1);
    });
    it("rejects a non-regular upload before opening it", async () => {
        await fs.mkdir(path.join(directory, "subdir"));
        const opened = vi.spyOn(fs, "open");
        await expect(store().upload("file", "subdir")).rejects.toMatchObject({ details: { code: "InvalidPath", outcome: "not_applied" } });
        expect(opened).not.toHaveBeenCalled();
        expect(remote.requests).toHaveLength(0);
    });
    it("preserves destination-specific JSON options on edit, but discards them on explicit replacement", async () => {
        const configPath = path.join(directory, "client.json");
        const entry: McpServerEntry = { command: "npx", args: ["-y", "@akms/mcp-s3"], env: { S3_BUCKET: "test-bucket" } };
        await fs.writeFile(configPath, JSON.stringify({ theme: "dark", mcpServers: { connection: { ...entry, disabled: true, timeout: 60000 } } }));
        const target = createJsonFileTarget({ id: "cursor", label: "Cursor", filePath: configPath });
        target.writeEntry("connection", { ...entry, env: { S3_BUCKET: "changed-bucket" } });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({ theme: "dark", mcpServers: { connection: { disabled: true, timeout: 60000, env: { S3_BUCKET: "changed-bucket" } } } });
        target.writeEntry("connection", entry, { replace: true });
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers.connection).toEqual(entry);
    });
    it("asks before overwriting a connection created while the add form was open", async () => {
        const input = new PassThrough(); const output = new PassThrough();
        const existing: McpServerEntry = { command: "other", args: [], env: { KEEP: "yes" } };
        const entries: Record<string, McpServerEntry> = {};
        const target: ConfigTarget = {
            id: "codex", label: "Codex", location: "test fixture", detected: true,
            readEntries: () => structuredClone(entries), hasEntry: (name) => Object.hasOwn(entries, name),
            writeEntry: vi.fn((name, entry) => { entries[name] = entry; return { status: "written" as const, detail: "test fixture" }; }),
            removeEntry: vi.fn(),
        };
        let screen = "";
        output.on("data", (chunk) => {
            const text = String(chunk); screen += text;
            if(text.includes("Connection ready")) entries.new = existing;
        });
        input.end(["a", "new", "aws", "my-bucket", "us-east-1", "default", "", "n", "", "", "n", "save", "n", "q"].join("\n") + "\n");
        await runConfigCommand({ input, output, targets: [target] });
        expect(screen).toContain("Overwrite");
        expect(target.writeEntry).not.toHaveBeenCalled();
        expect(entries.new).toEqual(existing);
    });
    it("refuses to overwrite an entry changed while editing", async () => {
        const input = new PassThrough(); const output = new PassThrough();
        const original: McpServerEntry = { command: "npx", args: ["-y", "@akms/mcp-s3"], env: { S3_BUCKET: "original-bucket" } };
        let current = original;
        const changed = { ...original, env: { S3_BUCKET: "external-change" } };
        const target: ConfigTarget = {
            id: "codex", label: "Codex", location: "test fixture", detected: true,
            readEntries: () => ({ connection: structuredClone(current) }), hasEntry: () => true,
            writeEntry: vi.fn(() => ({ status: "written" as const, detail: "test fixture" })), removeEntry: vi.fn(),
        };
        let screen = "";
        output.on("data", (chunk) => {
            const text = String(chunk); screen += text;
            if(text.includes("Connection ready")) current = changed;
        });
        input.end(["connection", "e", "aws", "", "us-east-1", "default", "", "n", "", "", "n", "save", "q"].join("\n") + "\n");
        await runConfigCommand({ input, output, targets: [target] });
        expect(screen).toContain("changed while the form was open");
        expect(target.writeEntry).not.toHaveBeenCalled();
        expect(current).toEqual(changed);
    });
});
