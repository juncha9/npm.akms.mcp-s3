import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadS3Profile } from "../src/profile";
import { openDownload, openUpload } from "../src/local-files";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-s3-catalog-path-")); vi.stubEnv("AKMS_MCP_HOME", directory); });
afterEach(() => {
    vi.unstubAllEnvs();
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^akms-s3-catalog-path-/);
    fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["registry.json", "registry.previous.json"])("protects custom catalog credential file %s from both local transfer directions", async (file) => {
    const profile = loadS3Profile({ S3_BUCKET: "fixture", S3_REGION: "us-east-1", S3_LOCAL_ROOT: directory })!;
    fs.writeFileSync(path.join(directory, file), "fixture-only");
    await expect(openUpload(profile, file)).rejects.toThrow("Credential files");
    await expect(openDownload(profile, file)).rejects.toThrow("Credential files");
    fs.writeFileSync(path.join(directory, "ordinary.json"), "ordinary data");
    const ordinary = await openUpload(profile, "ordinary.json");
    await ordinary.handle.close();
});
