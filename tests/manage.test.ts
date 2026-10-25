import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runTargetConfigCommand as runConfigCommand, maskEntry } from "../src/modules/manage";
import type { ConfigTarget, McpServerEntry } from "../src/_types";

const entry: McpServerEntry = { command: "npx", args: ["-y", "@akms/mcp-s3"], env: { S3_BUCKET: "my-bucket", S3_AUTH: "static", S3_ACCESS_KEY_ID: "sensitive-key", S3_SECRET_ACCESS_KEY: "sensitive-secret", S3_SESSION_TOKEN: "sensitive-token", CUSTOM: "keep" } };
function target(id: ConfigTarget["id"], entries: Record<string, McpServerEntry> = {}) {
    const value: ConfigTarget = {
        id, label: id, location: "test fixture", detected: true,
        readEntries: () => structuredClone(entries), hasEntry: (name) => Object.hasOwn(entries, name),
        writeEntry: vi.fn((name, value) => { entries[name] = structuredClone(value); return { status: "written" as const, detail: "test fixture" }; }),
        removeEntry: vi.fn((name) => { delete entries[name]; return { status: "written" as const, detail: "test fixture" }; }),
    };
    return value;
}
async function run(targets: ConfigTarget[], lines: string[]) {
    const input = new PassThrough(); const output = new PassThrough(); let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    input.end(lines.join("\n") + "\n");
    await runConfigCommand({ targets, input, output, targetId: targets[0].id });
    return text;
}
describe("S3 configuration management", () => {
    it("copies exact entries to another agent without changing the active client", async () => {
        const source = target("claude-code", { connection: entry }); const destination = target("codex");
        const output = await run([source, destination], ["connection", "o", "codex", "b", "q"]);
        expect(destination.readEntries().connection).toEqual(entry);
        expect(source.writeEntry).not.toHaveBeenCalled();
        expect(output).toContain("Copied connection to codex");
        expect(output).not.toContain("sensitive-");
    });
    it.each(["", "n", "y", "ESC"])("asks before a same-name overwrite (%j)", async (answer) => {
        const source = target("claude-code", { connection: entry }); const destination = target("cursor", { connection: { command: "old", args: [], env: {} } });
        await run([source, destination], ["connection", "o", "cursor", answer, "b", "b", "q"]);
        if(answer === "y") expect(destination.readEntries().connection).toEqual(entry);
        else expect(destination.writeEntry).not.toHaveBeenCalled();
    });
    it("does not expose credentials in previews", () => { expect(JSON.stringify(maskEntry(entry))).not.toContain("sensitive-"); });
    it("creates an AWS connection and preserves literal prefix spaces", async () => {
        const destination = target("codex");
        const output = await run([destination], ["a", "new-s3", "aws", "my-bucket", "us-east-1", "default", " scope/ ", "n", "", "description", "n", "save", "q"]);
        expect(destination.readEntries()["new-s3"]).toMatchObject({ env: { S3_PREFIX: " scope/ ", S3_AUTH: "default", S3_BUCKET: "my-bucket" } });
        expect(destination.readEntries()["new-s3"].args).not.toContain("npx");
        expect(output).toContain("Saved");
    });
    it("cancels a form without saving and closes on malformed config", async () => {
        const destination = target("codex");
        await run([destination], ["a", "ESC", "q"]);
        expect(destination.writeEntry).not.toHaveBeenCalled();
        destination.readEntries = () => { throw new Error("sensitive-parser-input"); };
        const output = await run([destination], ["q"]);
        expect(output).toContain("Could not read");
        expect(output).not.toContain("sensitive-parser-input");
    });
    it("retains custom env and saved secrets on edit", async () => {
        const destination = target("codex", { connection: entry });
        await run([destination], ["connection", "e", "aws", "", "us-east-1", "static", "", "", "", "", "n", "", "", "n", "save", "q"]);
        expect(destination.readEntries().connection.env).toMatchObject(entry.env);
    });
});
