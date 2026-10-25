import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture";
import { SERVER_VERSION } from "../src/profile";

function environment() {
    return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("S3_"))) as Record<string, string>;
}
async function run(args: string[], env = {}) {
    const child = spawn(process.execPath, [path.resolve("lib/cli.js"), ...args], { env: { ...environment(), ...env }, windowsHide: true, stdio: "pipe" });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    return { code, stdout, stderr };
}
describe("built CLI", () => {
    it("prints version and help to stderr and rejects unknown flags", async () => {
        expect(await run(["--version"])).toEqual({ code: 0, stdout: "", stderr: SERVER_VERSION + "\n" });
        expect((await run(["--help"])).stderr).toContain("S3_ENDPOINT");
        expect((await run(["--unknown"])).code).toBe(1);
    });
    it("runs a read-only check and exits with an appropriate status", async () => {
        const remote = await fixture();
        try {
            const result = await run(["--check"], remote.env);
            expect(result.code).toBe(0); expect(result.stdout).toContain("Connected:");
            expect(result.stdout).toContain("were not tested");
            expect(remote.requests).toHaveLength(1);
            expect((await run(["--check"])).code).toBe(1);
        } finally { await remote.close(); }
    });
    it("speaks MCP stdio without human output on stdout and exits on close", async () => {
        const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("lib/cli.js")], env: environment(), stderr: "pipe" });
        const client = new Client({ name: "stdio-test", version: "1.0.0" });
        let stderr = ""; transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        try {
            await client.connect(transport);
            expect((await client.listTools()).tools).toHaveLength(8);
            expect((await client.callTool({ name: "s3_info" })).structuredContent).toMatchObject({ configured: false });
        } finally { await client.close(); }
        expect(stderr).toBe("");
    });
});
