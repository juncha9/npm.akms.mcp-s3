import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { S3Error } from "./errors";
import type { S3Profile } from "./profile";

const protectedPart = /^(?:\.akms|\.aws|\.ssh|\.codex|\.claude|\.cursor|\.config|\.env(?:\..*)?|credentials|id_rsa|id_ed25519|id_ecdsa|mcp\.json|\.mcp\.json|\.claude\.json|claude_desktop_config\.json)$/i;
function protect(file: string, profile: S3Profile): void {
    const registryFiles = process.env.AKMS_MCP_HOME ? ["registry.json", "registry.previous.json"].map(name => path.resolve(process.env.AKMS_MCP_HOME!, name)) : [];
    if(registryFiles.some(registry => path.resolve(file).toLowerCase() === registry.toLowerCase()) || file.split(/[\\/]/).some((part) => protectedPart.test(part)) || /\.(?:pem|key|p12|pfx)$/i.test(file) || (profile.caFile && path.resolve(file) === path.resolve(profile.caFile))) {
        throw new S3Error("ProtectedPath", "Credential files, private keys and MCP client configuration cannot be transferred.");
    }
}
function within(root: string, file: string): void {
    const relative = path.relative(root, file);
    if(!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new S3Error("OutsideLocalRoot", "The local file must be inside S3_LOCAL_ROOT.");
}

async function resolveFile(profile: S3Profile, input: string, upload: boolean) {
    if(!profile.localRoot) throw new S3Error("LocalTransferDisabled", "Configure S3_LOCAL_ROOT to enable file transfers.");
    if(!input || input.includes("\0") || (process.platform === "win32" && /[<>"|?*:]|[. ]$/.test(input.replace(/^[a-z]:/i, "")))) throw new S3Error("InvalidPath", "Invalid local file path.");
    const root = await fs.realpath(profile.localRoot);
    if(!(await fs.stat(root)).isDirectory()) throw new S3Error("InvalidPath", "S3_LOCAL_ROOT must be an existing directory.");
    const lexical = path.resolve(root, input);
    within(root, lexical);
    protect(lexical, profile);
    const parent = await fs.realpath(path.dirname(lexical));
    const file = upload ? await fs.realpath(lexical) : path.join(parent, path.basename(lexical));
    within(root, file);
    protect(file, profile);
    return { root, file, parent };
}

export async function openUpload(profile: S3Profile, input: string) {
    const resolved = await resolveFile(profile, input, true);
    const before = await fs.lstat(resolved.file);
    if(!before.isFile() || before.nlink !== 1) throw new S3Error("InvalidPath", "Upload requires a regular file with one hard link.");
    // Reject FIFOs/devices before opening, and prevent a replacement FIFO from
    // blocking the open on platforms that support nonblocking file descriptors.
    const handle = await fs.open(resolved.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = await handle.stat();
        const currentPath = await fs.realpath(resolved.file);
        within(resolved.root, currentPath);
        protect(currentPath, profile);
        const current = await fs.stat(currentPath);
        if(!stat.isFile() || stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino || stat.dev !== before.dev || stat.ino !== before.ino) throw new S3Error("InvalidPath", "Upload requires an unchanged regular file with one hard link.");
        if(stat.size > profile.limits.transfer) throw new S3Error("LimitExceeded", "The file exceeds S3_MAX_TRANSFER_BYTES.");
        return { handle, stat };
    } catch(error) { await handle.close(); throw error; }
}

export async function openDownload(profile: S3Profile, input: string) {
    const resolved = await resolveFile(profile, input, false);
    try { await fs.lstat(resolved.file); throw new S3Error("FileExists", "The local destination already exists; choose another path."); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = path.join(resolved.parent, `.akms-s3-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    let closed = false;
    return {
        handle,
        async commit(signal?: AbortSignal) {
            signal?.throwIfAborted();
            await handle.sync();
            signal?.throwIfAborted();
            await handle.close();
            closed = true;
            const parent = await fs.realpath(resolved.parent);
            if(parent !== resolved.parent) throw new S3Error("PathChanged", "The destination directory changed during the transfer.");
            signal?.throwIfAborted();
            // A hard link commits atomically and refuses to replace a concurrently created file.
            try { await fs.link(temporary, resolved.file); }
            catch(error) {
                if((error as NodeJS.ErrnoException).code === "EEXIST") throw new S3Error("FileExists", "The local destination already exists; choose another path.");
                throw new S3Error("LocalCommitFailed", "Could not commit the download. The destination filesystem must support hard links.");
            }
        },
        async cleanup() {
            try { if(!closed) await handle.close(); }
            finally { await fs.unlink(temporary).catch(() => {}); }
        },
    };
}
