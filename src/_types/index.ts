export interface McpServerEntry {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export type ConfigTargetId = "claude-code" | "claude-desktop" | "codex" | "cursor" | "registered";

export interface ConfigWriteResult {
    status: "written" | "unavailable";
    /** Where it went, or why it could not and what to do instead. */
    detail: string;
}

/** One MCP client's config: where its entries live and how to change them. */
export interface ConfigTarget {
    id: ConfigTargetId;
    label: string;
    /** The config file, as shown to the user. */
    location: string;
    /** True when the client's CLI is on PATH or its config file exists. */
    detected: boolean;
    /**
     * Every `mcpServers` entry in the file, ours or not; entries this package cannot parse
     * are skipped.
     *
     * @throws {Error} If the file exists but cannot be parsed.
     */
    prepareEntry?(name: string, entry: McpServerEntry, oldName?: string): McpServerEntry;
    readEntries(): Record<string, McpServerEntry>;
    /** Includes names whose entries are not supported by readEntries(), such as HTTP servers. */
    hasEntry?(name: string): boolean;
    /** replace discards destination-specific entry options when copying between clients. */
    writeEntry(name: string, entry: McpServerEntry, options?: { replace?: boolean }): ConfigWriteResult;
    removeEntry(name: string): ConfigWriteResult;
    renameEntry?(oldName: string, name: string, entry: McpServerEntry): ConfigWriteResult;
}
