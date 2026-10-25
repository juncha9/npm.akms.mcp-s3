import { launchCommand, launchKind } from "../registration/runtime";
import type { Registry } from "../registration/registry";
import { RegistryError } from "../registration/registry";
import { ManagedSession } from "../registration/menu";
import type { ManagementMode } from "../registration/menu";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { ConfigTarget, McpServerEntry } from "@/_types";
import { ConfigError, loadS3Profile, SERVER_VERSION } from "../../profile";
import { copyEntryToClient } from "./copy-entry";
import { PromptBackError, PromptClosedError, Prompter, type SelectItem } from "./prompter";
import { listConfigTargets, renderMcpServerTable } from "./targets";
import { runConnectionCheck } from "./connection-check";

export { runConnectionCheck } from "./connection-check";
export interface ConfigCommandOptions { input: Readable; output: Writable; targets?: ConfigTarget[]; targetId?: string; registryPath?: string; mode?: ManagementMode; runtimeOptions?: Registry["runtimeOptions"]; management?: ManagedSession }
export function isOurEntry(entry: McpServerEntry): boolean { return launchKind(entry) === "s3"; }
export function maskEntry(entry: McpServerEntry): McpServerEntry {
    return { ...entry, env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, /KEY|SECRET|TOKEN|PASSWORD/i.test(key) ? "********" : value])) };
}

async function form(prompter: Prompter, output: Writable, target: ConfigTarget, name?: string, original?: McpServerEntry, management?: ManagedSession): Promise<void> {
    const entryName = name ?? await prompter.askRequired("Connection name", "s3");
    const env = { ...original?.env };
    const set = async (field: string, label: string, required = false) => {
        const value = required ? await prompter.askRequired(label, env[field]) : await prompter.ask(`${label} (use - to clear)`, env[field] ?? "", { trim: field !== "S3_PREFIX" });
        if(value === "-" || !value) delete env[field]; else env[field] = value;
    };
    env.S3_BACKEND = await prompter.select("Storage API", [{ value: "aws", label: "AWS S3" }, { value: "compatible", label: "S3-compatible" }], { defaultValue: env.S3_BACKEND === "compatible" ? "compatible" : "aws" });
    await set("S3_BUCKET", "Bucket", true);
    await set("S3_REGION", "Signing region", env.S3_BACKEND === "compatible");
    if(env.S3_BACKEND === "compatible") await set("S3_ENDPOINT", "Endpoint root URL (https://host; explicit http:// allowed)", true);
    else { delete env.S3_ENDPOINT; delete env.S3_CHECKSUM_MODE; }
    const priorAuth = env.S3_AUTH;
    env.S3_AUTH = await prompter.select("Credentials", [
        { value: "static", label: "Explicit access key and secret" },
        { value: "profile", label: "AWS shared profile" },
        { value: "default", label: "AWS default provider chain", hint: "uses this machine's AWS identity" },
    ], { defaultValue: ["static", "profile", "default"].includes(env.S3_AUTH) ? env.S3_AUTH : env.S3_BACKEND === "aws" ? "default" : "static" });
    if(env.S3_AUTH !== "static" || priorAuth !== env.S3_AUTH) {
        delete env.S3_ACCESS_KEY_ID; delete env.S3_SECRET_ACCESS_KEY; delete env.S3_SESSION_TOKEN;
    }
    if(env.S3_AUTH === "profile") await set("S3_PROFILE", "AWS profile", true); else delete env.S3_PROFILE;
    if(env.S3_AUTH === "static") {
        for(const [field, label, required] of [["S3_ACCESS_KEY_ID", "Access key ID", true], ["S3_SECRET_ACCESS_KEY", "Secret access key", true], ["S3_SESSION_TOKEN", "Session token", false]] as const) {
            for(;;) {
                const value = await prompter.askSecret(`${label}${env[field] ? " (Enter keeps existing; - clears)" : required ? "" : " (optional)"}`);
                if(value === "-") delete env[field]; else if(value) env[field] = value;
                if(!required || env[field]) break;
                prompter.write("  This credential is required.\n");
            }
        }
    }
    await set("S3_PREFIX", "Allowed literal prefix; keys must include it");
    env.S3_READONLY = String(await prompter.askYesNo("Read-only remote access?", env.S3_READONLY === "true"));
    await set("S3_LOCAL_ROOT", "Local transfer directory (optional)");
    await set("S3_DESCRIPTION", "Description (optional)");
    if(await prompter.askYesNo("Configure advanced options?", false)) {
        env.S3_FORCE_PATH_STYLE = String(await prompter.askYesNo("Use path-style bucket addressing?", env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "true" : env.S3_BACKEND === "compatible"));
        await set("S3_CA_FILE", "Custom trusted CA file (optional)");
        if(env.S3_BACKEND === "compatible") env.S3_CHECKSUM_MODE = await prompter.select("Checksum compatibility", [{ value: "WHEN_SUPPORTED", label: "WHEN_SUPPORTED (default)" }, { value: "WHEN_REQUIRED", label: "WHEN_REQUIRED", hint: "explicit compatibility option" }], { defaultValue: env.S3_CHECKSUM_MODE === "WHEN_REQUIRED" ? "WHEN_REQUIRED" : "WHEN_SUPPORTED" });
        for(const field of ["S3_MAX_LIST_ITEMS", "S3_MAX_READ_BYTES", "S3_MAX_WRITE_BYTES", "S3_MAX_TRANSFER_BYTES", "S3_REQUEST_TIMEOUT_MS", "S3_TRANSFER_TIMEOUT_MS", "S3_MAX_CONCURRENCY"]) await set(field, `${field} (blank uses default)`);
    }
    loadS3Profile(env);
    let entry: McpServerEntry = original ? { ...original, env } : { ...launchCommand("s3"), env };
    entry = target.prepareEntry?.(entryName, entry, name) ?? entry;
    for(;;) {
        prompter.clearScreen();
        prompter.write(`\n${JSON.stringify({ [entryName]: maskEntry(entry) }, null, 2)}\n`);
        const action = await prompter.select("Connection ready", [{ value: "save", label: target.id === "registered" ? "Save and apply to all registered services" : "Save" }, { value: "check", label: "Test connection" }, { value: "back", label: "Cancel" }], { cancelValue: "back" });
        if(action === "back") return;
        if(action === "check") { await runConnectionCheck(env, output); await prompter.pause(); continue; }
        // A form can remain open while another process changes the client config.
        // Ask against the current destination, immediately before writing it.
        const latest = target.readEntries();
        const exists = target.hasEntry?.(entryName) ?? Object.hasOwn(latest, entryName);
        if(!name && exists) {
            if(!await prompter.askYesNo("That name already exists. Overwrite it?", false)) return;
        } else if(name && (!exists || !isDeepStrictEqual(latest[entryName], original))) {
            prompter.write("  This connection changed while the form was open. Reload it before editing; nothing was saved.\n");
            await prompter.acknowledge();
            return;
        }
        const result = target.writeEntry(entryName, entry, !name ? { replace: true } : undefined);
        prompter.clearScreen();
        prompter.write(`  ${result.status === "written" ? "Saved" : "Not saved"}: ${result.detail}\n`);
        if(result.status === "written") await management?.checkSaved(prompter, entryName, original);
        if(result.status === "written") prompter.write("  Reconnect or restart the client to load the change.\n");
        await prompter.acknowledge();
        return;
    }
}

export async function runTargetConfigCommand(options: ConfigCommandOptions): Promise<void> {
    const targets = options.targets ?? listConfigTargets();
    let target = options.targetId ? targets.find((item) => item.id === options.targetId) : targets[0];
    if(!target) throw new ConfigError("Unknown or unavailable --target. Use claude-code, codex, claude-desktop or cursor.");
    const prompter = new Prompter(options.input, options.output);
    try {
        if(options.management && !await options.management.initialize(prompter)) return;
        for(;;) {
            try {
                prompter.clearScreen();
                prompter.write("S3 connections\n");
                options.management?.writeStatus(prompter);
                let entries: Record<string, McpServerEntry>;
                try { entries = target.readEntries(); }
                catch {
                    prompter.write("  Could not read this client's configuration. Correct its syntax and permissions, then reopen config.\n");
                    await prompter.acknowledge();
                    return;
                }
                const choices: SelectItem<string>[] = Object.entries(entries).filter(([, entry]) => isOurEntry(entry)).map(([name, entry]) => ({ value: `entry:${name}`, key: name, label: name, hint: entry.env.S3_BUCKET }));
                choices.push({ separator: true }, { value: "add", key: "a", label: "Add S3 connection" });
                if(targets.length > 1) choices.push({ value: "client", key: "c", label: "Change client" });
                if(options.management) { options.management.decorate(choices); choices.push(...options.management.items()); }
                choices.push({ value: "quit", key: "q", label: "Quit" });
                const selected = await prompter.select(`S3 connections - ${target.label}`, choices, { cancelValue: "quit" });
                if(selected === "quit") return;
                prompter.clearScreen();
                if(options.management && await options.management.handle(selected, prompter)) continue;
                if(selected === "client") {
                    const id = await prompter.select("Client", targets.map((item) => ({ value: item.id, label: item.label, hint: item.location })), { defaultValue: target.id });
                    target = targets.find((item) => item.id === id)!;
                } else if(selected === "add") await form(prompter, options.output, target, undefined, undefined, options.management);
                else if(selected.startsWith("entry:")) {
                    const name = selected.slice(6);
                    for(;;) {
                        prompter.clearScreen();
                        const actions: SelectItem<string>[] = [{ value: "edit", key: "e", label: "Edit settings" }, { value: "check", key: "c", label: "Test connection" }, { value: "print", key: "p", label: "Print entry (includes credentials)" }];
                        if(targets.length > 1) actions.push({ value: "copy", key: "o", label: "Copy to another client" });
                        actions.push({ value: "remove", key: "r", label: "Remove connection" }, { value: "back", key: "b", label: "Back" });
                        const action = await prompter.select(name, actions, { cancelValue: "back" });
                        if(action === "back") break;
                        try {
                            prompter.clearScreen();
                            if(action === "edit") { if(options.management && !await options.management.prepareRuntime(prompter, entries[name])) break; await form(prompter, options.output, target, name, entries[name], options.management); break; }
                            if(action === "check") { await runConnectionCheck(entries[name].env, options.output); await prompter.pause(); }
                            if(action === "copy") { await copyEntryToClient(prompter, target, targets, name, entries[name]); await prompter.acknowledge(); }
                            if(action === "print") { prompter.write(`\n${target.id === "codex" ? renderMcpServerTable(name, entries[name]) : JSON.stringify({ [name]: entries[name] }, null, 2)}\n`); await prompter.pause(); }
                            if(action === "remove" && await prompter.askYesNo(`Remove ${name} from ${target.label}?`, false)) {
                                const result = target.removeEntry(name);
                                prompter.clearScreen();
                                prompter.write(`  ${result.status}: ${result.detail}\n`);
                                await prompter.acknowledge();
                                break;
                            }
                        } catch(error) { if(!(error instanceof PromptBackError)) throw error; }
                    }
                }
            } catch(error) {
                if(error instanceof PromptClosedError) return;
                if(error instanceof PromptBackError) continue;
                // Config writers already redact parser content; unknown errors stay generic.
                prompter.write(`  ${(error instanceof ConfigError || error instanceof RegistryError) ? error.message : "Could not complete the action. Check configuration file syntax, permissions and connection settings."}\n`);
                await prompter.acknowledge();
            }
        }
    } catch(error) {
        if(error instanceof PromptClosedError || error instanceof PromptBackError) return;
        throw error;
    } finally { prompter.close(); }
}

/** Independent registration and shared connection management; never invokes @akms/mcp. */
export async function runConfigCommand(options: ConfigCommandOptions): Promise<void> {
    const management = new ManagedSession({ kind: "s3", version: SERVER_VERSION, targets: options.targets ?? listConfigTargets(), registryPath: options.registryPath, mode: options.mode, targetId: options.targetId, runtimeOptions: options.runtimeOptions });
    return runTargetConfigCommand({ ...options, targets: [management.target], targetId: undefined, management });
}
