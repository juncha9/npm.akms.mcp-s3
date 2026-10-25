import type { Writable } from "node:stream";
import { ConfigError, loadS3Profile, type S3Env } from "../../profile";
import { S3Store } from "../../store";
import { safeError } from "../../errors";
import { CheckProgress } from "./check-progress";

export async function runConnectionCheck(env: S3Env, output: Writable): Promise<boolean> {
    const progress = new CheckProgress(output);
    let store: S3Store | undefined;
    try {
        progress.start("Validate connection settings");
        const profile = loadS3Profile(env);
        if(!profile) throw new ConfigError("S3 is not configured. Run akms-mcp-s3 config.");
        store = new S3Store(profile);
        const report = await store.check((phase) => progress.start(phase));
        progress.finish(true);
        output.write(`  Connected: ${JSON.stringify(report.bucket)} (prefix ${JSON.stringify(report.prefix)})\n`);
        output.write("  Verified: credentials and listing. Read, write, delete and conditional operations were not tested.\n");
        return true;
    } catch(error) {
        progress.finish(false);
        output.write(`  Check failed: ${error instanceof ConfigError ? error.message : safeError(error).message}\n`);
        return false;
    } finally { progress.stop(); store?.close(); }
}
