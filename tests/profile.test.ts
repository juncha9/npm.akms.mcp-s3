import { describe, expect, it } from "vitest";
import { loadS3Profile, toS3Summary } from "../src/profile";
import { checkKey, writeHeaders } from "../src/policy";
const aws = { S3_BUCKET: "my-bucket" };
const compatible = { ...aws, S3_BACKEND: "compatible", S3_ENDPOINT: "https://storage.example", S3_REGION: "region-1", S3_AUTH: "static", S3_ACCESS_KEY_ID: "secret-key", S3_SECRET_ACCESS_KEY: "secret-value" };

describe("connection policy", () => {
    it("supports unconfigured startup and AWS defaults", () => {
        expect(loadS3Profile({})).toBeNull();
        expect(loadS3Profile(aws)).toMatchObject({ auth: "default", readonly: false, forcePathStyle: false, limits: { concurrency: 4, transfer: 536870912 } });
    });
    it("selects compatible defaults and excludes credentials from info", () => {
        const profile = loadS3Profile(compatible)!;
        expect(profile.forcePathStyle).toBe(true);
        expect(JSON.stringify(toS3Summary(profile))).not.toContain("secret-");
    });
    it.each([
        { S3_BUCKET: "arn:aws:s3:::bucket" }, { S3_BUCKET: "bucket--x-s3" }, { S3_BUCKET: "abc..xyz" },
        { S3_READONLY: "yes" }, { S3_MAX_READ_BYTES: "NaN" }, { S3_MAX_CONCURRENCY: "0" }, { S3_MAX_LIST_ITEMS: "1001" },
        { S3_AUTH: "static" }, { S3_ACCESS_KEY_ID: "never-echo-this" }, { S3_PROFILE: "mixed" },
        { S3_ENDPOINT: "https://example.com" }, { S3_REGION: "bad/region" },
    ])("rejects invalid AWS settings %j", (overrides) => { expect(() => loadS3Profile({ ...aws, ...overrides })).toThrow(); });
    it.each(["https://name:password@host", "https://host/path", "https://host/?q=secret", "https://host/#fragment", "file:///tmp", "https://host\\path"])("rejects unsafe endpoint %s", (endpoint) => { expect(() => loadS3Profile({ ...compatible, S3_ENDPOINT: endpoint })).toThrow(); });
    it("requires explicit credentials mode and region for a custom endpoint", () => {
        expect(() => loadS3Profile({ ...compatible, S3_AUTH: undefined })).toThrow("S3_AUTH");
        expect(() => loadS3Profile({ ...compatible, S3_REGION: undefined })).toThrow("S3_REGION");
    });
    it("preserves keys exactly and enforces a literal prefix", () => {
        const profile = loadS3Profile({ ...aws, S3_PREFIX: "project/" })!;
        expect(checkKey(profile, "project/../ spaces %2f\\x")).toBe("project/../ spaces %2f\\x");
        expect(() => checkKey(profile, "project-other/file")).toThrow();
        expect(() => checkKey(profile, "project/\ud800")).toThrow();
    });
    it("requires exact conditions and never silently changes write mode", () => {
        const profile = loadS3Profile(aws)!;
        expect(writeHeaders(profile, {})).toMatchObject({ IfNoneMatch: "*" });
        expect(writeHeaders(profile, { mode: "replace", if_match: '"etag"' })).toMatchObject({ IfMatch: '"etag"' });
        expect(() => writeHeaders(profile, { mode: "replace" })).toThrow();
        expect(() => writeHeaders(profile, { mode: "upsert", if_match: "*" })).toThrow();
        expect(() => writeHeaders(profile, { metadata: { "bad\r\nkey": "x" } })).toThrow();
        expect(() => writeHeaders({ ...profile, readonly: true }, {})).toThrow();
    });
});
