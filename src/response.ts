import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { S3Error } from "./errors";

type Response = Pick<GetObjectCommandOutput, "$metadata" | "ContentLength" | "ContentRange">;

/** Validate the range independently of the requested cap: compatible servers may
 * return fewer bytes than requested, but must identify what those bytes represent. */
export function previewRange(response: Response): { total?: number; returnedBytes?: number } {
    const length = response.ContentLength;
    if(length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new S3Error("InvalidResponse", "The service returned an invalid Content-Length.");
    if(response.$metadata.httpStatusCode === 200 && response.ContentRange === undefined) return { total: length, returnedBytes: length };
    const match = response.ContentRange?.match(/^bytes 0-(\d+)\/(\d+)$/);
    if(response.$metadata.httpStatusCode !== 206 || !match) throw new S3Error("InvalidResponse", "The preview response must identify a byte range starting at zero.");
    const returnedBytes = Number(match[1]) + 1;
    const total = Number(match[2]);
    if(!Number.isSafeInteger(returnedBytes) || !Number.isSafeInteger(total) || returnedBytes < 1 || total < returnedBytes || (length !== undefined && length !== returnedBytes)) {
        throw new S3Error("InvalidResponse", "The preview response has inconsistent range and length headers.");
    }
    return { total, returnedBytes };
}

export function requireFullObject(response: Response): void {
    if(response.$metadata.httpStatusCode !== 200 || response.ContentRange !== undefined) throw new S3Error("InvalidResponse", "A full download was requested but the service returned a partial response.");
    if(response.ContentLength !== undefined && (!Number.isSafeInteger(response.ContentLength) || response.ContentLength < 0)) throw new S3Error("InvalidResponse", "The service returned an invalid Content-Length.");
}
