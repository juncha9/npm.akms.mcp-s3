import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { S3Env } from "../src/profile";

export interface StoredObject { body: Buffer; etag: string; type: string; metadata?: Record<string, string>; encoding?: string }
export interface Request { method: string; key: string; url: string; headers: http.IncomingHttpHeaders; query: URLSearchParams; body?: Buffer }
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export async function fixture() {
    const objects = new Map<string, StoredObject>();
    const requests: Request[] = [];
    let intercept: ((request: Request, response: http.ServerResponse) => boolean | Promise<boolean>) | undefined;
    const put = (key: string, body: string | Buffer, type = "text/plain", encoding?: string) => {
        const data = Buffer.from(body);
        const object: StoredObject = { body: data, etag: `"${createHash("sha256").update(data).digest("hex")}"`, type, encoding };
        objects.set(key, object);
        return object;
    };
    const server = http.createServer(async (req, res) => {
        try {
            const raw = req.url ?? "/";
            const [pathname, query] = raw.split("?");
            const request: Request = { method: req.method!, key: decodeURIComponent(pathname.replace(/^\/test-bucket\/?/, "")), url: raw, headers: req.headers, query: new URLSearchParams(query) };
            requests.push(request);
            if(intercept && await intercept(request, res)) return;
            const fail = (status: number, code: string) => { res.writeHead(status, { "content-type": "application/xml", "x-amz-request-id": "fixture-request" }); res.end(`<Error><Code>${code}</Code><Message>fixture failure</Message></Error>`); };
            if(request.query.has("list-type")) {
                const prefix = request.query.get("prefix") ?? "";
                const delimiter = request.query.get("delimiter");
                const items: Array<{ key: string; prefix: boolean }> = [];
                const seen = new Set<string>();
                for(const key of [...objects.keys()].sort()) {
                    if(!key.startsWith(prefix)) continue;
                    const index = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
                    const value = index < 0 ? key : key.slice(0, index + 1);
                    if(seen.has(value)) continue;
                    seen.add(value); items.push({ key: value, prefix: index >= 0 });
                }
                const offset = Number(request.query.get("continuation-token") ?? 0);
                const limit = Number(request.query.get("max-keys") ?? 100);
                const page = items.slice(offset, offset + limit);
                const more = offset + limit < items.length;
                const encoded = request.query.get("encoding-type") === "url";
                const keyText = (key: string) => xml(encoded ? encodeURIComponent(key) : key);
                res.writeHead(200, { "content-type": "application/xml" });
                res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${encoded ? "<EncodingType>url</EncodingType>" : ""}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${offset + limit}</NextContinuationToken>` : ""}${page.map((item) => item.prefix ? `<CommonPrefixes><Prefix>${keyText(item.key)}</Prefix></CommonPrefixes>` : `<Contents><Key>${keyText(item.key)}</Key><Size>${objects.get(item.key)!.body.length}</Size><ETag>${xml(objects.get(item.key)!.etag)}</ETag></Contents>`).join("")}</ListBucketResult>`);
                return;
            }
            const existing = objects.get(request.key);
            if(req.headers["if-match"] && req.headers["if-match"] !== existing?.etag) { fail(412, "PreconditionFailed"); return; }
            if(req.headers["if-none-match"] === "*" && existing) { fail(412, "PreconditionFailed"); return; }
            if(req.method === "PUT") {
                const chunks: Buffer[] = [];
                for await(const chunk of req) chunks.push(Buffer.from(chunk));
                let body = Buffer.concat(chunks);
                if(req.headers["content-encoding"]?.includes("aws-chunked")) {
                    const decoded: Buffer[] = [];
                    let offset = 0;
                    for(;;) {
                        const end = body.indexOf("\r\n", offset);
                        const size = parseInt(body.subarray(offset, end).toString(), 16);
                        if(!size) break;
                        decoded.push(body.subarray(end + 2, end + 2 + size)); offset = end + 2 + size + 2;
                    }
                    body = Buffer.concat(decoded);
                }
                request.body = body;
                const current = objects.get(request.key);
                if(req.headers["if-none-match"] === "*" && current) { fail(412, "PreconditionFailed"); return; }
                if(req.headers["if-match"] && req.headers["if-match"] !== current?.etag) { fail(412, "PreconditionFailed"); return; }
                const object = put(request.key, body, req.headers["content-type"] ?? "application/octet-stream");
                object.metadata = Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.startsWith("x-amz-meta-")).map(([key, value]) => [key.slice(11), String(value)]));
                res.writeHead(200, { etag: object.etag, "x-amz-version-id": "version-1", "x-amz-request-id": "fixture-request" }); res.end(); return;
            }
            if(req.method === "DELETE") {
                objects.delete(request.key);
                res.writeHead(204, { "x-amz-delete-marker": "true", "x-amz-version-id": "delete-version" }); res.end(); return;
            }
            if(!existing) { fail(404, "NoSuchKey"); return; }
            const headers: Record<string, string | number> = { etag: existing.etag, "content-type": existing.type, "content-length": existing.body.length, "x-amz-version-id": "version-1", "x-amz-request-id": "fixture-request" };
            if(existing.encoding) headers["content-encoding"] = existing.encoding;
            for(const [key, value] of Object.entries(existing.metadata ?? {})) headers[`x-amz-meta-${key}`] = value;
            if(req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
            let body = existing.body;
            const range = req.headers.range?.match(/^bytes=0-(\d+)$/);
            if(range && body.length === 0) { fail(416, "InvalidRange"); return; }
            if(range && body.length) {
                body = body.subarray(0, Number(range[1]) + 1);
                headers["content-range"] = `bytes 0-${body.length - 1}/${existing.body.length}`;
                headers["content-length"] = body.length;
            }
            res.writeHead(range ? 206 : 200, headers); res.end(body);
        } catch { res.destroy(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env: S3Env = { S3_BACKEND: "compatible", S3_BUCKET: "test-bucket", S3_REGION: "us-east-1", S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, S3_AUTH: "static", S3_ACCESS_KEY_ID: "fixture-access", S3_SECRET_ACCESS_KEY: "fixture-secret", S3_CHECKSUM_MODE: "WHEN_REQUIRED" };
    return { env, put, objects, requests, intercept(fn: typeof intercept) { intercept = fn; }, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
