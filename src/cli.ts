import { RegistryError } from "./modules/registration/registry";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createS3CatalogServer, createS3McpServer } from "./server";
import { ConfigError, SERVER_NAME, SERVER_VERSION } from "./profile";
import { runConfigCommand, runConnectionCheck } from "./modules/manage";

async function main() {
    const args = process.argv.slice(2);
    if(args.length === 1 && ["--version", "-v"].includes(args[0])) { process.stderr.write(`${SERVER_VERSION}\n`); return; }
    if(args.length === 1 && ["--help", "-h"].includes(args[0])) {
        process.stderr.write("Catalog mode: akms-mcp-s3 --catalog loads bucket connections from the shared registry.\n\n");
        process.stderr.write("AKMS MCP S3 - one bucket per connection\n\nUsage:\n  akms-mcp-s3                         MCP stdio server\n  akms-mcp-s3 config [--target ID]     Configure a connection\n  akms-mcp-s3 register               Register AI services\n  akms-mcp-s3 sync                   Retry and review shared settings\n  akms-mcp-s3 --check                 Read-only connection check\n  akms-mcp-s3 --version\n\nTargets: claude-code, codex, claude-desktop, cursor\nConfiguration: S3_BUCKET, S3_BACKEND, S3_REGION, S3_AUTH.\nCompatible storage also requires S3_ENDPOINT and explicit S3_AUTH.\nRun config or see README for credentials, scope and transfer limits.\nCatalog: ~/.akms/mcp/registry.json (or $AKMS_MCP_HOME/registry.json) stores settings and passwords in plaintext.\n");
        return;
    }
    if(["config", "register", "sync"].includes(args[0]) && (args.length === 1 || (args.length === 3 && args[1] === "--target"))) { await runConfigCommand({ input: process.stdin, output: process.stdout, targetId: args[2], mode: args[0] as "config" | "register" | "sync" }); return; }
    if(args.length === 1 && args[0] === "--check") { process.exitCode = await runConnectionCheck(process.env, process.stdout) ? 0 : 1; return; }
    const catalogMode = args.length === 1 && args[0] === "--catalog";
    if(args.length && !catalogMode) throw new ConfigError("Unknown arguments. Run akms-mcp-s3 --help.");
    const instance = catalogMode ? createS3CatalogServer() : createS3McpServer();
    let closing = false;
    const shutdown = () => {
        if(closing) return;
        closing = true;
        const deadline = setTimeout(() => process.exit(1), 3000);
        deadline.unref();
        // Keep the bounded fallback active while any credential provider or in-flight
        // stream still owns handles. The unref timer does not delay a normal exit.
        void instance.shutdown().catch(() => { process.exitCode = 1; });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
    process.stdout.on("error", (error: NodeJS.ErrnoException) => { if(error.code === "EPIPE") shutdown(); else { process.exitCode = 1; shutdown(); } });
    await instance.server.connect(new StdioServerTransport());
    if("connectionCount" in instance) process.stderr.write(JSON.stringify({ message: "mcp server ready on stdio", server: SERVER_NAME, version: SERVER_VERSION, pid: process.pid, connections: instance.connectionCount }) + "\n");
}

main().catch((error: unknown) => {
    process.stderr.write(`akms-mcp-s3: ${(error instanceof ConfigError || error instanceof RegistryError) ? error.message : "Unable to start. Check configuration and local file permissions."}\n`);
    process.exitCode = 1;
});
