export type MutationOutcome = "applied" | "not_applied" | "unknown";
export class S3Error extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = "S3Error"; }
}
export interface OperationError {
    code: string;
    message: string;
    http_status?: number;
    request_id?: string;
    outcome?: MutationOutcome;
}
export class OperationFailure extends Error {
    constructor(public readonly details: OperationError) { super(details.message); this.name = "OperationFailure"; }
}
/** Do not echo SDK/provider messages: they can include URLs, keys or local credentials. */
export function safeError(error: unknown, mutation = false, dispatched = false): OperationError {
    if(error instanceof OperationFailure) return error.details;
    const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number; requestId?: string } } | null;
    const status = value?.$metadata?.httpStatusCode;
    const known = error instanceof S3Error;
    let code = known ? error.code : "RequestFailed";
    let message = known ? error.message : "S3 request failed. Check the endpoint, credentials, region and permissions.";
    if(!known && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "ENOTDIR", "EISDIR", "ELOOP"].includes(value?.code ?? "")) {
        code = "LocalFileError";
        message = "A local file operation failed. Check that the configured root and parent directory exist, and verify file permissions and free space.";
    }
    if(status === 404) { code = "NotFound"; message = "The object or bucket was not found."; }
    if(status === 403) { code = "AccessDenied"; message = "The request was denied. Check credentials and bucket permissions."; }
    if(status === 412 || status === 409) { code = "Conflict"; message = "The object condition failed or a concurrent operation conflicted. Inspect the object before trying again."; }
    if(status === 501) { code = "Unsupported"; message = "The storage service does not support this operation or condition. No unconditional fallback was attempted."; }
    if(value?.name === "AbortError" || value?.name === "TimeoutError") { code = "Cancelled"; message = "The operation was cancelled or its deadline expired."; }
    return {
        code, message,
        ...(status ? { http_status: status } : {}),
        ...(value?.$metadata?.requestId ? { request_id: value.$metadata.requestId } : {}),
        ...(mutation ? { outcome: !dispatched || (status != null && [400, 401, 403, 404, 405, 409, 411, 412, 413, 415, 501].includes(status)) ? "not_applied" as const : "unknown" as const } : {}),
    };
}
