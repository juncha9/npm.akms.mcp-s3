import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createS3McpServer } from "../src/server";
import { fixture } from "./fixture";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for(const close of cleanup.splice(0).reverse()) await close(); });
async function connect(env = {}) {
    const instance = createS3McpServer(env);
    const client = new Client({ name: "s3-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), instance.server.connect(serverTransport)]);
    cleanup.push(async () => { await client.close(); await instance.shutdown(); });
    return client;
}

describe("MCP contract", () => {
    it("lists all tools and reports an unconfigured server without trying credentials", async () => {
        const client = await connect();
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["s3_delete", "s3_download", "s3_info", "s3_list", "s3_read", "s3_stat", "s3_upload", "s3_write"]);
        expect(listed.tools.find((tool) => tool.name === "s3_write")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
        expect((await client.callTool({ name: "s3_info" })).structuredContent).toMatchObject({ configured: false });
        expect(await client.callTool({ name: "s3_read", arguments: { key: "file" } })).toMatchObject({ isError: true, structuredContent: { error: { code: "NotConfigured" } } });
    });
    it("returns matching text and structured data, preserving mutation outcomes", async () => {
        const remote = await fixture(); cleanup.push(() => remote.close());
        const client = await connect(remote.env);
        const info = await client.callTool({ name: "s3_info" });
        expect(JSON.stringify(info)).not.toContain("fixture-secret");
        const created = await client.callTool({ name: "s3_write", arguments: { key: "text", text: "hello" } });
        expect(created.structuredContent).toMatchObject({ outcome: "applied", key: "text", version_id: "version-1" });
        expect(JSON.parse((created.content as Array<{ text: string }>)[0].text)).toEqual(created.structuredContent);
        const failed = await client.callTool({ name: "s3_write", arguments: { key: "text", text: "collision" } });
        expect(failed).toMatchObject({ isError: true, structuredContent: { error: { outcome: "not_applied", code: "Conflict" } } });
        const read = await client.callTool({ name: "s3_read", arguments: { key: "text" } });
        expect(read.structuredContent).toMatchObject({ text: "hello", truncated: false });
    });
});
