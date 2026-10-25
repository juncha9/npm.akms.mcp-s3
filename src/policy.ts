import { S3Error } from "./errors";
import type { S3Profile } from "./profile";

export interface WriteOptions {
    mode?: "create" | "replace" | "upsert";
    if_match?: string;
    content_type?: string;
    cache_control?: string;
    metadata?: Record<string, string>;
}

export function checkKey(profile: S3Profile, key: string, prefix = false): string {
    if(typeof key !== "string" || (!prefix && key.length === 0) || Buffer.byteLength(key) > 1024 || !key.isWellFormed() || key.includes("\0")) throw new S3Error("InvalidKey", "Keys must be valid Unicode, at most 1024 UTF-8 bytes, without NUL; object keys cannot be empty.");
    if(!key.startsWith(profile.prefix)) throw new S3Error("OutsidePrefix", "The key or prefix is outside S3_PREFIX. Supply the full bucket-relative key.");
    return key;
}

export function checkEtag(value?: string): string | undefined {
    if(value !== undefined && (!value || value.trim() !== value || value === "*" || /[\x00-\x20\x7f,]/.test(value) || Buffer.byteLength(value) > 1024)) throw new S3Error("InvalidCondition", "if_match must be one exact ETag, not a wildcard or list.");
    return value;
}

export function writeHeaders(profile: S3Profile, options: WriteOptions) {
    if(profile.readonly) throw new S3Error("ReadOnly", "This connection is read-only.");
    const mode = options.mode ?? "create";
    if(!["create", "replace", "upsert"].includes(mode)) throw new S3Error("InvalidMode", "mode must be create, replace or upsert.");
    const etag = checkEtag(options.if_match);
    if(mode === "replace" ? !etag : etag !== undefined) throw new S3Error("InvalidCondition", "replace requires if_match; create and upsert do not accept if_match.");
    for(const value of [options.content_type, options.cache_control]) {
        if(value !== undefined && (!/^[\x20-\x7e]*$/.test(value) || value.length > 2048)) throw new S3Error("InvalidMetadata", "Content headers must be printable ASCII of at most 2048 bytes.");
    }
    let bytes = 0;
    for(const [key, value] of Object.entries(options.metadata ?? {})) {
        if(!/^[a-z0-9_-]+$/.test(key) || typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) throw new S3Error("InvalidMetadata", "Metadata names must be lowercase ASCII letters, digits, underscores or hyphens; values must be printable ASCII.");
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    }
    if(bytes > 2048) throw new S3Error("InvalidMetadata", "Metadata exceeds 2048 bytes.");
    return {
        IfNoneMatch: mode === "create" ? "*" : undefined,
        IfMatch: mode === "replace" ? etag : undefined,
        ContentType: options.content_type,
        CacheControl: options.cache_control,
        Metadata: options.metadata,
    };
}

export function bounded(value: number | undefined, max: number, name: string): number {
    if(value === undefined) return max;
    if(!Number.isSafeInteger(value) || value < 1 || value > max) throw new S3Error("LimitExceeded", `${name} must be between 1 and ${max}.`);
    return value;
}
