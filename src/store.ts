import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClients } from "./client";
import { OperationFailure, S3Error, safeError } from "./errors";
import { bounded, checkEtag, checkKey, writeHeaders, type WriteOptions } from "./policy";
import { toS3Summary, type S3Profile } from "./profile";
import { openDownload, openUpload } from "./local-files";
import { WorkQueue } from "./queue";
import { previewRange, requireFullObject } from "./response";

interface Context { signal: AbortSignal; dispatch(): void }
export interface ListOptions { prefix?: string; recursive?: boolean; limit?: number; cursor?: string }

function metadata(result: { ETag?: string; VersionId?: string; ContentType?: string; ContentLength?: number; LastModified?: Date; CacheControl?: string; ContentEncoding?: string; Metadata?: Record<string, string> }) {
    return { etag: result.ETag, version_id: result.VersionId, content_type: result.ContentType, size: result.ContentLength, last_modified: result.LastModified?.toISOString(), cache_control: result.CacheControl, content_encoding: result.ContentEncoding, metadata: result.Metadata };
}
function requestId(result: { $metadata: { requestId?: string } }) { return result.$metadata.requestId; }

/** Aborting SDK credential resolution must not leave the caller waiting for its timeout. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: () => void = () => {};
    try {
        return await Promise.race([
            promise.then((value) => {
                if(signal.aborted) (value as { Body?: { destroy?: () => void } })?.Body?.destroy?.();
                return value;
            }),
            new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if(signal.aborted) abort();
            }),
        ]);
    } finally { signal.removeEventListener("abort", abort); }
}

export class S3Store {
    private readonly profile: S3Profile;
    private readonly clients: ReturnType<typeof createClients>;
    private readonly queue: WorkQueue;
    private readonly closing = new AbortController();
    private readonly cursorSecret = randomBytes(32);

    constructor(profile: S3Profile) {
        this.profile = structuredClone(profile);
        this.clients = createClients(this.profile);
        this.queue = new WorkQueue(profile.limits.concurrency);
    }

    info() {
        return {
            configured: true,
            ...toS3Summary(this.profile),
            capabilities: {
                conditional_writes: this.profile.backend === "aws" ? "documented" : "unknown",
                conditional_delete: this.profile.backend === "aws" ? "documented" : "unknown",
                local_transfers: Boolean(this.profile.localRoot),
                multipart: false,
            },
            notes: [
                "Keys are full bucket-relative strings; S3_PREFIX is a literal access boundary, not an automatic prefix.",
                "Compatible endpoints must enforce conditional headers. A read-only check cannot verify this; test provider behavior before relying on conditions.",
                "ETags are opaque conditions, not content hashes or guaranteed revision identifiers.",
            ],
        };
    }

    close(): void {
        this.closing.abort(new DOMException("Server closed", "AbortError"));
        this.clients.close();
    }

    private async run<T>(mutation: boolean, transfer: boolean, signal: AbortSignal | undefined, work: (context: Context) => Promise<T>): Promise<T> {
        const deadline = new AbortController();
        const timeout = setTimeout(() => deadline.abort(new DOMException("Deadline expired", "TimeoutError")), transfer ? this.profile.limits.transferMs : this.profile.limits.requestMs);
        timeout.unref();
        const combined = AbortSignal.any([deadline.signal, this.closing.signal, ...(signal ? [signal] : [])]);
        let dispatched = false;
        try {
            return await this.queue.run(combined, () => work({ signal: combined, dispatch() { combined.throwIfAborted(); dispatched = true; } }));
        } catch(error) {
            // MCP cancellation notifications can carry a string reason. Preserve
            // cancellation semantics without echoing that caller-provided text.
            const failure = combined.aborted && error === combined.reason ? new DOMException("Operation cancelled", "AbortError") : error;
            throw new OperationFailure(safeError(failure, mutation, dispatched));
        }
        finally { clearTimeout(timeout); }
    }

    async check(onProgress?: (phase: string) => void, signal?: AbortSignal) {
        return this.run(false, false, signal, async (context) => {
            onProgress?.("Resolve region and credentials");
            const clients = await abortable(this.clients.get(), context.signal);
            await abortable(Promise.all([clients.read.config.region(), clients.read.config.credentials()]), context.signal);
            onProgress?.("List the configured bucket prefix");
            context.dispatch();
            const result = await abortable(clients.read.send(new clients.sdk.ListObjectsV2Command({ Bucket: this.profile.bucket, Prefix: this.profile.prefix, MaxKeys: 1, EncodingType: "url" }), { abortSignal: context.signal }), context.signal);
            return { connected: true, bucket: this.profile.bucket, prefix: this.profile.prefix, checked: ["credentials", "list"], untested: ["read", "write", "delete", "conditional operations"], request_id: requestId(result) };
        });
    }

    async list(options: ListOptions = {}, signal?: AbortSignal) {
        return this.run(false, false, signal, async (context) => {
            const prefix = checkKey(this.profile, options.prefix ?? this.profile.prefix, true);
            const limit = bounded(options.limit, this.profile.limits.list, "limit");
            const recursive = options.recursive ?? false;
            const binding = JSON.stringify([this.profile.bucket, prefix, recursive, limit]);
            const token = options.cursor ? this.decodeCursor(options.cursor, binding) : undefined;
            const clients = await abortable(this.clients.get(), context.signal);
            context.dispatch();
            const result = await abortable(clients.read.send(new clients.sdk.ListObjectsV2Command({ Bucket: this.profile.bucket, Prefix: prefix, MaxKeys: limit, Delimiter: recursive ? undefined : "/", ContinuationToken: token, EncodingType: "url" }), { abortSignal: context.signal }), context.signal);
            const decode = (value: string | undefined) => {
                if(value === undefined) throw new S3Error("InvalidResponse", "The service omitted an object key or common prefix.");
                try { return result.EncodingType === "url" ? decodeURIComponent(value) : value; }
                catch { throw new S3Error("InvalidResponse", "The service returned an invalid URL-encoded key."); }
            };
            // Only decode the wire encoding declared by S3; never decode tool inputs.
            const objects = (result.Contents ?? []).map((item) => ({ key: checkKey(this.profile, decode(item.Key)), size: item.Size, etag: item.ETag, last_modified: item.LastModified?.toISOString(), storage_class: item.StorageClass }));
            const prefixes = (result.CommonPrefixes ?? []).map((item) => checkKey(this.profile, decode(item.Prefix), true));
            if(objects.length + prefixes.length > limit || (result.IsTruncated && !result.NextContinuationToken)) throw new S3Error("InvalidResponse", "The service returned inconsistent pagination; no cursor was advanced.");
            return { bucket: this.profile.bucket, prefix, recursive, objects, prefixes, cursor: result.IsTruncated ? this.encodeCursor(binding, result.NextContinuationToken!) : null, request_id: requestId(result) };
        });
    }

    async stat(key: string, signal?: AbortSignal) {
        return this.run(false, false, signal, async (context) => {
            checkKey(this.profile, key);
            const clients = await abortable(this.clients.get(), context.signal);
            context.dispatch();
            const result = await abortable(clients.read.send(new clients.sdk.HeadObjectCommand({ Bucket: this.profile.bucket, Key: key }), { abortSignal: context.signal }), context.signal);
            return { key, ...metadata(result), request_id: requestId(result) };
        });
    }

    async read(key: string, options: { max_bytes?: number; if_match?: string } = {}, signal?: AbortSignal) {
        return this.run(false, false, signal, async (context) => {
            checkKey(this.profile, key);
            const max = bounded(options.max_bytes, this.profile.limits.read, "max_bytes");
            const condition = checkEtag(options.if_match);
            const clients = await abortable(this.clients.get(), context.signal);
            context.dispatch();
            let result;
            try {
                result = await abortable(clients.read.send(new clients.sdk.GetObjectCommand({ Bucket: this.profile.bucket, Key: key, Range: `bytes=0-${max}`, IfMatch: condition }), { abortSignal: context.signal }), context.signal);
            } catch(error) {
                // S3 returns 416 for any byte range on an empty object. Confirm with the
                // same condition before treating this as an empty text preview.
                if((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 416) throw error;
                context.signal.throwIfAborted();
                const head = await abortable(clients.read.send(new clients.sdk.HeadObjectCommand({ Bucket: this.profile.bucket, Key: key, IfMatch: condition }), { abortSignal: context.signal }), context.signal);
                if(head.ContentLength !== 0) throw error;
                return { key, text: "", bytes: 0, truncated: false, etag: head.ETag, version_id: head.VersionId, content_type: head.ContentType, request_id: requestId(head) };
            }
            const body = result.Body as Readable | undefined;
            if(!body) throw new S3Error("InvalidResponse", "The service returned no object body.");
            const abort = () => body.destroy(new DOMException("Cancelled", "AbortError"));
            context.signal.addEventListener("abort", abort, { once: true });
            try {
                context.signal.throwIfAborted();
                const range = previewRange(result);
                if(result.ContentEncoding && result.ContentEncoding !== "identity") throw new S3Error("BinaryObject", "Encoded objects must be downloaded; automatic decompression is disabled.");
                if(result.ContentType && !/^(text\/|application\/(?:json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-ndjson|yaml|x-yaml|toml)(?:;|$))/i.test(result.ContentType)) throw new S3Error("BinaryObject", "This content type is not a UTF-8 text preview type. Use s3_download.");
                const chunks: Buffer[] = [];
                let received = 0;
                for await(const chunk of body) {
                    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    const used = data.subarray(0, max + 1 - received);
                    chunks.push(used);
                    received += used.length;
                    if(received > max) break;
                }
                const data = Buffer.concat(chunks);
                if(received <= max && range.returnedBytes !== undefined && received !== range.returnedBytes) throw new S3Error("InvalidResponse", "The preview body did not match the declared response length.");
                const truncated = received > max || (range.total !== undefined && range.total > received);
                const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
                let text: string;
                try { text = decoder.decode(data.subarray(0, max), { stream: truncated }); }
                catch { throw new S3Error("BinaryObject", "The object is not valid UTF-8. Use s3_download."); }
                if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new S3Error("BinaryObject", "The object contains binary control bytes. Use s3_download.");
                return { key, text, bytes: Buffer.byteLength(text), truncated, etag: result.ETag, version_id: result.VersionId, content_type: result.ContentType, request_id: requestId(result) };
            } finally { context.signal.removeEventListener("abort", abort); body.destroy(); }
        });
    }

    async write(key: string, text: string, options: WriteOptions = {}, signal?: AbortSignal) {
        return this.run(true, false, signal, async (context) => {
            checkKey(this.profile, key);
            const headers = writeHeaders(this.profile, options);
            if(!text.isWellFormed()) throw new S3Error("InvalidText", "text must be valid Unicode.");
            if(Buffer.byteLength(text, "utf8") > this.profile.limits.write) throw new S3Error("LimitExceeded", "text exceeds S3_MAX_WRITE_BYTES.");
            const body = Buffer.from(text, "utf8");
            const clients = await abortable(this.clients.get(), context.signal);
            context.dispatch();
            const result = await abortable(clients.mutate.send(new clients.sdk.PutObjectCommand({ Bucket: this.profile.bucket, Key: key, ...headers, ContentType: headers.ContentType ?? "text/plain; charset=utf-8", Body: body, ContentLength: body.length }), { abortSignal: context.signal }), context.signal);
            return { outcome: "applied" as const, key, bytes: body.length, etag: result.ETag, version_id: result.VersionId, request_id: requestId(result) };
        });
    }

    async delete(key: string, options: { if_match?: string } = {}, signal?: AbortSignal) {
        return this.run(true, false, signal, async (context) => {
            checkKey(this.profile, key);
            if(this.profile.readonly) throw new S3Error("ReadOnly", "This connection is read-only.");
            const condition = checkEtag(options.if_match);
            const clients = await abortable(this.clients.get(), context.signal);
            context.dispatch();
            const result = await abortable(clients.mutate.send(new clients.sdk.DeleteObjectCommand({ Bucket: this.profile.bucket, Key: key, IfMatch: condition }), { abortSignal: context.signal }), context.signal);
            return { outcome: "applied" as const, key, version_id: result.VersionId, delete_marker: result.DeleteMarker, request_id: requestId(result), note: "The delete request succeeded. This does not prove prior existence or permanent removal of historical versions." };
        });
    }

    async upload(key: string, localPath: string, options: WriteOptions = {}, signal?: AbortSignal) {
        return this.run(true, true, signal, async (context) => {
            checkKey(this.profile, key);
            const headers = writeHeaders(this.profile, options);
            const { handle, stat } = await openUpload(this.profile, localPath);
            let bytes = 0;
            const limit = this.profile.limits.transfer;
            const source = handle.createReadStream({ autoClose: false });
            const counted = new Transform({
                transform(chunk, _encoding, callback) {
                    bytes += chunk.length;
                    callback(bytes > stat.size || bytes > limit ? new S3Error("FileChanged", "The upload file grew during transfer.") : null, chunk);
                },
                flush(callback) { callback(bytes !== stat.size ? new S3Error("FileChanged", "The upload file changed size during transfer.") : null); },
            });
            const pumping = pipeline(source, counted, { signal: context.signal });
            void pumping.catch(() => {});
            try {
                const clients = await abortable(this.clients.get(), context.signal);
                context.dispatch();
                const result = await abortable(clients.mutate.send(new clients.sdk.PutObjectCommand({ Bucket: this.profile.bucket, Key: key, ...headers, Body: counted, ContentLength: stat.size }), { abortSignal: context.signal }), context.signal);
                let warning: string | undefined;
                try {
                    await pumping;
                    const after = await handle.stat();
                    if(after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) warning = "The local file changed during upload; the transferred data is not a guaranteed snapshot.";
                } catch { warning = "S3 accepted the upload, but local source verification failed. Inspect the uploaded object before relying on its contents."; }
                return { outcome: "applied" as const, key, bytes, etag: result.ETag, version_id: result.VersionId, request_id: requestId(result), ...(warning ? { warning } : {}) };
            } finally {
                source.destroy(); counted.destroy();
                await pumping.catch(() => {});
                await handle.close().catch(() => {});
            }
        });
    }

    async download(key: string, localPath: string, options: { if_match?: string } = {}, signal?: AbortSignal) {
        return this.run(false, true, signal, async (context) => {
            checkKey(this.profile, key);
            const condition = checkEtag(options.if_match);
            const destination = await openDownload(this.profile, localPath);
            let body: Readable | undefined;
            const abort = () => body?.destroy(new DOMException("Cancelled", "AbortError"));
            context.signal.addEventListener("abort", abort, { once: true });
            try {
                const clients = await abortable(this.clients.get(), context.signal);
                context.dispatch();
                const result = await abortable(clients.read.send(new clients.sdk.GetObjectCommand({ Bucket: this.profile.bucket, Key: key, IfMatch: condition }), { abortSignal: context.signal }), context.signal);
                body = result.Body as Readable | undefined;
                if(!body) throw new S3Error("InvalidResponse", "The service returned no object body.");
                context.signal.throwIfAborted();
                requireFullObject(result);
                if((result.ContentLength ?? 0) > this.profile.limits.transfer) throw new S3Error("LimitExceeded", "The object exceeds S3_MAX_TRANSFER_BYTES.");
                let bytes = 0;
                for await(const chunk of body) {
                    context.signal.throwIfAborted();
                    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += data.length;
                    if(bytes > this.profile.limits.transfer) throw new S3Error("LimitExceeded", "The streamed object exceeds S3_MAX_TRANSFER_BYTES.");
                    let offset = 0;
                    while(offset < data.length) {
                        const written = await destination.handle.write(data, offset, data.length - offset);
                        if(written.bytesWritten === 0) throw new S3Error("LocalWriteFailed", "Could not write the downloaded bytes.");
                        offset += written.bytesWritten;
                    }
                }
                if(result.ContentLength !== undefined && bytes !== result.ContentLength) throw new S3Error("InvalidResponse", "The download length did not match Content-Length.");
                context.signal.throwIfAborted();
                await destination.commit(context.signal);
                return { key, local_path: localPath, bytes, etag: result.ETag, version_id: result.VersionId, request_id: requestId(result) };
            } finally { context.signal.removeEventListener("abort", abort); body?.destroy(); await destination.cleanup(); }
        });
    }

    private encodeCursor(binding: string, token: string): string {
        const body = Buffer.from(JSON.stringify({ binding, token })).toString("base64url");
        return `${body}.${createHmac("sha256", this.cursorSecret).update(body).digest("base64url")}`;
    }
    private decodeCursor(cursor: string, binding: string): string {
        try {
            if(cursor.length > 65536) throw new Error();
            const [body, signature, extra] = cursor.split(".");
            const expected = createHmac("sha256", this.cursorSecret).update(body).digest();
            const given = Buffer.from(signature, "base64url");
            if(extra !== undefined || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error();
            const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
            if(decoded.binding !== binding || typeof decoded.token !== "string" || !decoded.token) throw new Error();
            return decoded.token;
        } catch { throw new S3Error("InvalidCursor", "Use the cursor from the same connection and unchanged list query. Cursors expire when the server restarts."); }
    }
}
