import path from "node:path";
import os from "node:os";

export const SERVER_NAME = "akms-mcp-s3";
export const SERVER_VERSION = "0.3.0";
export type S3Env = Record<string, string | undefined>;
export interface S3Profile {
    backend: "aws" | "compatible";
    bucket: string;
    region?: string;
    endpoint?: string;
    forcePathStyle: boolean;
    auth: "default" | "profile" | "static";
    profile?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    prefix: string;
    readonly: boolean;
    localRoot?: string;
    caFile?: string;
    alias?: string;
    description?: string;
    checksumMode: "WHEN_SUPPORTED" | "WHEN_REQUIRED";
    limits: { list: number; read: number; write: number; transfer: number; requestMs: number; transferMs: number; concurrency: number };
}

export class ConfigError extends Error {
    constructor(message: string) { super(message); this.name = "ConfigError"; }
}

export function expandPath(value: string): string {
    return path.resolve(value === "~" ? os.homedir() : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value);
}

/** Parse once, before making requests. Errors contain field names, never field values. */
export function loadS3Profile(env: S3Env = process.env): S3Profile | null {
    const present = (name: string) => env[name] !== undefined && env[name] !== "";
    if(!Object.keys(env).some((name) => name.startsWith("S3_") && present(name))) return null;
    const required = (name: string): string => {
        if(!present(name)) throw new ConfigError(`${name} is required.`);
        return env[name]!;
    };
    const choice = <T extends string>(name: string, options: readonly T[], fallback?: T): T => {
        const value = present(name) ? env[name]! : fallback;
        if(value == null || !options.includes(value as T)) throw new ConfigError(`${name} must be one of: ${options.join(", ")}.`);
        return value as T;
    };
    const boolean = (name: string, fallback: boolean) => {
        if(!present(name)) return fallback;
        if(env[name] !== "true" && env[name] !== "false") throw new ConfigError(`${name} must be true or false.`);
        return env[name] === "true";
    };
    const integer = (name: string, fallback: number, max: number) => {
        if(!present(name)) return fallback;
        if(!/^\d+$/.test(env[name]!)) throw new ConfigError(`${name} must be a positive integer.`);
        const value = Number(env[name]);
        if(!Number.isSafeInteger(value) || value < 1 || value > max) throw new ConfigError(`${name} must be between 1 and ${max}.`);
        return value;
    };
    const backend = choice("S3_BACKEND", ["aws", "compatible"], "aws");
    const bucket = required("S3_BUCKET");
    if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || /\.\-|\-\./.test(bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(bucket) || /(--x-s3|--ol-s3|\.mrap|-s3alias|--table-s3)$/.test(bucket)) {
        throw new ConfigError("S3_BUCKET must be a general-purpose bucket name (no ARN, access point or directory bucket).");
    }
    let endpoint: string | undefined;
    if(backend === "compatible") {
        const raw = required("S3_ENDPOINT");
        try {
            const url = new URL(raw);
            if(!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || raw.includes("\\")) throw new Error();
            endpoint = url.origin;
        } catch { throw new ConfigError("S3_ENDPOINT must be an http(s) root URL without user info, path, query or fragment."); }
    } else if(present("S3_ENDPOINT")) throw new ConfigError("S3_ENDPOINT requires S3_BACKEND=compatible.");
    const auth = choice("S3_AUTH", ["default", "profile", "static"], backend === "aws" ? "default" : undefined);
    if(auth !== "static" && ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN"].some(present)) throw new ConfigError("Static keys require S3_AUTH=static.");
    if(auth !== "profile" && present("S3_PROFILE")) throw new ConfigError("S3_PROFILE requires S3_AUTH=profile.");
    const region = backend === "compatible" ? required("S3_REGION") : env.S3_REGION || undefined;
    if(region && !/^[a-zA-Z0-9-]+$/.test(region)) throw new ConfigError("S3_REGION contains invalid characters.");
    const prefix = env.S3_PREFIX ?? "";
    if(Buffer.byteLength(prefix) > 1024 || !prefix.isWellFormed() || prefix.includes("\0")) throw new ConfigError("S3_PREFIX must be valid Unicode of at most 1024 UTF-8 bytes without NUL.");
    const checksumMode = choice("S3_CHECKSUM_MODE", ["WHEN_SUPPORTED", "WHEN_REQUIRED"], "WHEN_SUPPORTED");
    if(backend === "aws" && checksumMode !== "WHEN_SUPPORTED") throw new ConfigError("S3_CHECKSUM_MODE=WHEN_REQUIRED is only available in compatible mode.");
    return {
        backend, bucket, endpoint, region, auth,
        profile: auth === "profile" ? required("S3_PROFILE") : undefined,
        credentials: auth === "static" ? { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY"), sessionToken: env.S3_SESSION_TOKEN || undefined } : undefined,
        forcePathStyle: boolean("S3_FORCE_PATH_STYLE", backend === "compatible"),
        prefix, readonly: boolean("S3_READONLY", false),
        localRoot: present("S3_LOCAL_ROOT") ? expandPath(env.S3_LOCAL_ROOT!) : undefined,
        caFile: present("S3_CA_FILE") ? expandPath(env.S3_CA_FILE!) : undefined,
        alias: env.S3_ALIAS || undefined, description: env.S3_DESCRIPTION || undefined, checksumMode,
        limits: {
            list: integer("S3_MAX_LIST_ITEMS", 100, 1000),
            read: integer("S3_MAX_READ_BYTES", 65536, 1048576),
            write: integer("S3_MAX_WRITE_BYTES", 262144, 1048576),
            transfer: integer("S3_MAX_TRANSFER_BYTES", 536870912, 536870912),
            requestMs: integer("S3_REQUEST_TIMEOUT_MS", 30000, 300000),
            transferMs: integer("S3_TRANSFER_TIMEOUT_MS", 300000, 3600000),
            concurrency: integer("S3_MAX_CONCURRENCY", 4, 32),
        },
    };
}

export function toS3Summary(profile: S3Profile) {
    const { credentials: _credentials, profile: _profile, caFile: _ca, ...safe } = profile;
    return safe;
}
