# @akms/mcp-s3

MCP stdio server for object CRUD in **one AWS S3 or S3-compatible bucket per connection**. Requires Node.js 22+.

Use **session server mode** to share one process among this kind's connections in each client session. Each connection keeps its own target, credentials and policy; its tool names carry the connection prefix. The environment-based examples below describe individual mode. See [Session server mode](#session-server-mode).

## Installation

```sh
npm install -g @akms/mcp-s3@latest
akms-mcp-s3 register
akms-mcp-s3 config
```

## Minimum working configuration

Install the server from **Runtime** before using these manual examples. On Windows its script is `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime/node_modules/@akms/mcp-s3/lib/cli.js`; on macOS/Linux insert `lib/` before `node_modules`. Replace the placeholder below with that absolute path. Use the Node executable from `node -p "process.execPath"` as `command`. The `config` command writes both paths for you.

### AWS S3

This entry supplies credentials explicitly, so no preconfigured AWS profile is needed. Replace the bucket, region and keys with an existing bucket's values and credentials permitted to access it. Use Node.js 22+ and npm for setup (or a linked local checkout as described below).

```json
{
  "mcpServers": {
    "s3": {
      "command": "node",
      "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-s3/lib/cli.js"],
      "env": {
        "S3_BUCKET": "my-assets",
        "S3_REGION": "ap-northeast-2",
        "S3_AUTH": "static",
        "S3_ACCESS_KEY_ID": "your-access-key",
        "S3_SECRET_ACCESS_KEY": "your-secret-key"
      }
    }
  }
}
```

These five fields are sufficient for this static-credential example; temporary credentials also require `S3_SESSION_TOKEN`. `S3_BACKEND` defaults to `aws`, so no endpoint is needed. If an AWS credential provider is already available to the MCP process, the `env` block can instead contain just `S3_BUCKET` and `S3_REGION`: authentication defaults to `default`. `S3_REGION` can also be omitted when the AWS SDK can resolve the correct region from its configuration. Credentials and region must still be resolvable when a storage operation runs.

### S3-compatible storage

Keep the same `command` and `args`, and replace the entire `env` block with these seven fields:

```json
{
  "S3_BACKEND": "compatible",
  "S3_BUCKET": "my-assets",
  "S3_ENDPOINT": "https://storage.example.com",
  "S3_REGION": "us-east-1",
  "S3_AUTH": "static",
  "S3_ACCESS_KEY_ID": "your-access-key",
  "S3_SECRET_ACCESS_KEY": "your-secret-key"
}
```

Use your service's endpoint and required signing region. Compatible mode requires an explicit endpoint, region and authentication choice. Path-style addressing defaults to `true`; set `S3_FORCE_PATH_STYLE=false` if your service requires virtual-hosted addressing.

### Optional settings and client registration

Both examples enable object listing, text reads/writes and deletion, subject to storage permissions and conditional-operation support. A connection check needs permission to list the bucket; it does not prove that other operations are allowed. Add `S3_LOCAL_ROOT` pointing to an **existing local directory** only for file upload/download. Without it, those two tools are disabled. `S3_PREFIX` defaults to the whole bucket, and writes are allowed by default; add `S3_READONLY=true` for a read-only entry.

The full JSON example fits an MCP client's `mcpServers` configuration, such as a project `.mcp.json` or Cursor's `mcp.json`. The direct Node command also works on Windows. For Codex TOML or automatic registration, use the `config` commands below.

## Configure a connection

Register the AI services you use once, then manage connections in one shared list. **This package works independently; installing or running `@akms/mcp` is optional.**

```sh
akms-mcp-s3 register   # toggle services, then Apply registration
akms-mcp-s3 config     # add, edit, check, print or remove connections
akms-mcp-s3 sync       # review differences and retry pending changes
```

### AKMS runtime and existing connections

Managed connections start Node directly using a dedicated installation at `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. This directory is independent of Node version managers. The setup CLI may be installed globally as above or opened once with `npx -y @akms/mcp-s3@latest config`; it is separate from the server runtime saved in client settings.

Before Add or a standard-launch Edit, setup installs a missing runtime with `npm install --global --prefix "<AKMS runtime directory>" --prefer-online --no-fund --no-audit @akms/mcp-s3@latest`. If the installed version is older than this setup package, it offers an update (default Yes); declining continues with the installed version. Linked development packages skip this prompt. Host-key saves for standard launches also check the runtime before writing. Custom launch commands keep their existing command and require no managed-runtime installation. If an update fails but an installed runtime is still usable, setup reports the error and continues with that version. Servers do not invoke npm or query updates when AI clients connect.

To migrate existing entries, open `akms-mcp-s3 config`, choose **Runtime**, install the runtime if needed, then choose **Use for existing connections**. Both legacy npx entries and direct paths in ordinary global installations can be converted. Review and apply the list, then **restart or reconnect the AI clients** to replace running processes. Connection values and credentials stay intact; custom commands and external client edits are preserved for individual review. Register/import legacy entries first if they are missing from the shared list. Version-pinned npx entries switch to the installed version shown in the preview.

**Runtime > Update runtime installation** explicitly installs the latest release into this same directory. The Node executable keeps its existing alias path, allowing nvm-windows to switch Node versions while the package path stays fixed. If the Node command path or `AKMS_MCP_HOME` moves, reapply current paths from Runtime. Removing the runtime directory breaks entries that use it.

For development, build the checkout and link it with `npm install -g --prefix "<AKMS runtime directory>" "<checkout path>"`. Linked packages retain the runtime alias path; automatic updates do not overwrite the checkout link. See [README_DEV.md](README_DEV.md). `@akms/mcp` remains optional.

`config` always shows the connection menu, including Add, Register, Sync, Import and Runtime. With no registered services, Add displays a message asking you to open Register and returns to the menu without opening a form or changing settings. Claude Code, Codex, Claude Desktop and Cursor are supported; Enter toggles each service and Apply saves the selection. `--target codex` preselects Codex in Register; it does not restrict subsequent saves to Codex.

On an interactive terminal, connection menus, registration and comparisons use separate screens. Results and errors stay visible until Enter or Esc; returning to the menu shows current services and any connections needing attention. Piped commands keep plain output and need no extra answers. Sync labels the saved AKMS version and the current service version separately. Numbered choices show which service receives a value or whether it becomes the AKMS value for all registered services. Long values wrap, changed text is highlighted, and confirmation names the destinations.

Service selection is shared across the AKMS packages. Every saved connection is applied to all registered services, and a newly registered service receives existing shared connections. Unregistering removes only entries managed by AKMS from that service and retains the shared catalog. Restart or reconnect the MCP client to load changed settings.

### Startup checks and updates

After saving a changed connection, applying Runtime launch commands, or updating from **Updates**, setup starts each distinct saved command once without shell interpolation. It sends MCP `initialize` and `tools/list`, then closes stdin; it does not invoke database, SSH, WSL or S3 tools. The check takes at most about 10 seconds per entry, plus bounded process cleanup. Results show the server version and tool count, or the exit code and masked stderr tail. Standard runtime script paths and spawn command paths stay visible for diagnosis. Session checks also verify a tool-name prefix for every saved connection. A failed check keeps the saved settings: fix it before restarting or reconnecting AI clients. Identical command/arguments/environment values share one check.

Open **Updates** in the launcher or any package config menu to see installed and latest published runtime versions. Version lookup runs only when this screen opens or **Refresh versions** is chosen, with a short timeout; offline results show **Unavailable**. Update one runtime or all installed runtimes with newer releases; missing runtimes can be installed individually. Development links are displayed but never updated, and WSL is listed only on Windows. Updates use the same dedicated AKMS runtime directory and check that kind's saved connections afterward. Reconnect your AI clients to use the new runtime. The helper itself is not updated here.

Register confirmation defaults to **No** when deselecting a previously registered service; otherwise it defaults to **Yes**.

### Session server mode

New catalogs start in version 2 with session mode enabled. Register your AI services, then add connections; setup creates each kind's session entry automatically. Existing version 1 catalogs keep individual mode until you approve **Migrate registry** or a per-kind **Runtime > Switch to session server** conversion (default No). Register/import their existing connections first. Each registered AI service gets one `akms_db`, `akms_ssh`, `akms_wsl` or `akms_s3` entry for that kind, running Node directly with `--catalog`. The helper package is optional. A client session still owns its own stdio process; connections of the same kind share that process.

The server reads its connections from the shared catalog at startup. Tools include the connection name, for example `production__db_query`; their arguments stay unchanged. Add/Edit/Remove updates the catalog; reconnect your clients to load changes. Removing the last connection removes the session entry. An invalid connection is excluded while valid ones remain available; `<kind>_catalog_status` reports the loaded/excluded names without credentials. No database, SSH, WSL or S3 connection opens just to list tools.

Converting an existing version 1 catalog upgrades it to version 2 and keeps the previous revision. Older setup packages stop without modifying version 2. New kinds in a new catalog also default to sessions; each kind's explicit rollback choice is retained. AKMS removes managed individual entries only after verifying the session entry; external edits stay for **Sync** review. Custom launch commands are retained in the catalog for rollback but are not executed in session mode.

**Runtime > Switch back to per-connection entries** previews and restores the saved individual entries, including their credentials and launch commands. It removes the session entry after the replacements are verified. The registry stays version 2. **Reapply session launch command** updates paths after moving Node or the runtime. Restart/reconnect clients after either change.

Connection names use ASCII letters, digits, underscores or hyphens: DB up to 35 characters, SSH/WSL 30, S3 37. The four `akms_<kind>` names are reserved. These limits keep client-prefixed tool names within 64 characters; rename longer legacy entries before conversion.

### Migrate an older registry

When a version 1 registry or a version 2 registry without a default-mode marker is opened, the helper and each config menu show **Registry update available** and **Migrate registry**. Select it to review the ordered format steps, every kind's current layout, per-service additions/removals, and settings kept for Sync. Approval defaults to **No**.

Migration upgrades v1 to v2, records `defaultMode: "catalog"`, and converts individual kinds through the existing session conversion rules. Kinds explicitly switched back to individual entries keep that choice. Already bundled kinds keep their launch commands; an unmarked v2 containing only bundles receives the marker without client-file changes. Missing runtimes leave existing entries in place for **Runtime** installation and **Sync**. Startup checks verify the affected session tools after approval.

One `registry.previous.json` revision covers the whole migration. Repeating migration on a current registry does nothing. Runtime still offers per-kind conversion and rollback. **Runtime > Use individual entries for new kinds** turns the future-kind default off, and **Start new kinds as session servers** turns it back on; existing kinds retain their modes. The explicit `individual` default is also current format, so turning it off does not trigger another migration notice.

### Catalog security

The shared catalog is `~/.akms/mcp/registry.json`, or `$AKMS_MCP_HOME/registry.json`. It contains complete connection settings, including passwords and secret values **in plaintext**. In individual mode these values also appear in AI client entries. After successful session-mode conversion and resolution of any retained legacy entries, the catalog is the only active location for that kind's connection credentials; one previous-revision copy also contains them. S3 static credentials include S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_SESSION_TOKEN. SSH private-key settings store file paths, not the key files themselves.

On POSIX, new catalog files request mode `0600` and new catalog directories `0700`; existing permissions are not tightened. Windows uses inherited parent-directory ACLs (normally the user profile), not POSIX owner/group modes. Check access permissions when choosing a custom location.

Keep both catalog files private: do not commit it, share it, copy it to another person or PC, paste its contents into chats/issues/AI conversations, or ask an AI agent to print it. Exclude it from cloud sync and shared backups, or protect those copies. Prefer SSH key authentication over passwords where possible. If exposed, change the affected passwords or rotate the affected keys/tokens, then update the connections through `config`.

SSH blocks local uploads from and downloads into `.akms/mcp`. A custom `AKMS_MCP_HOME` outside that path is not protected as a whole: its `registry.json` and `registry.previous.json` are additionally blocked when the SSH process has that environment variable. Remote SSH paths have no catalog-specific block. WSL protects these paths through `/mnt/<drive>/`; native Linux paths have no catalog-specific block, and local Windows transfers depend on the installed SSH guard. The locked SSH 0.1.9 dependency does not block the catalog in those local transfers. Do not rely on these guards to keep the file private.

Each successful catalog-changing operation atomically keeps one previous revision as **`registry.previous.json`** in the same directory. Internal application bookkeeping does not replace that pre-operation revision, and a no-op Sync leaves it unchanged. The copy requests the catalog's existing file permissions; Windows uses inherited ACLs. This is one revision, not a history.

To recover, close configuration commands, preserve the current file if needed, and copy `registry.previous.json` over `registry.json` in that directory. Then reopen setup, review **Sync**, and reconnect clients. Recovery does not automatically revert client files.

A running session keeps its startup snapshot. If `registry.json` is missing or invalid, a newly started session exposes only its status tool; its empty client entry cannot reconstruct credentials through Import. Restore the previous revision or enter the connections again. Individual mode still uses each entry's environment, so its existing client entries keep working and can be imported after registering services again.

Each standalone package manages this versioned file directly and does not call the optional helper.

Register shows existing AKMS entry counts even before registration. Applying registration automatically imports existing connections whose versions match, merging identical copies into one shared item. In session mode, it replaces owned individual entries after verifying the session launch. If a runtime is missing, the existing entries stay in place: install it from Runtime, then run Sync. Differing versions remain intact for review. Results summarize completed connections and list only items needing attention. The comparison shows changed fields, labels description-only differences, and keeps secrets hidden. Use **Import existing connections** to review differences later or import all remaining matching entries together. When versions differ, review the masked settings and choose which version to apply, or give the imported connection another name to keep both. The menu shows per-connection application counts. Failed writes keep the saved values and successful service updates; **Sync** retries pending changes and offers explicit choices for external edits. Unrelated or conflicting unmanaged entries are preserved.

For a local checkout, build and link it into the dedicated runtime directory as described in README_DEV, then run `node lib/cli.js register` or `node lib/cli.js config`. The helper resolves child packages from npm; publish compatible releases before using its package routes.

Connection tests animate actual validation, credential resolution and listing phases. Interactive tests keep their result visible until Enter; `--check` exits immediately with status 0 or 1. A successful check confirms `ListObjectsV2` for the configured prefix. It does not verify object reads, writes, deletion or enforcement of conditional headers.

JSON and Codex TOML writes preserve unrelated configuration and use an adjacent temporary file before replacement. Codex inline/dotted server definitions can be read but cannot be edited automatically; use `[mcp_servers.name]` tables. Claude Code registration uses its installed CLI and attempts to restore the previous entry if replacement fails.

Saving a new connection checks for an existing name at Save time. An edit is refused if the saved command, arguments or environment changed while the form was open; reload the entry to edit its current values. Ordinary JSON stdio edits retain additional client options.

## Additional configuration examples

AWS shared profile, restricted to one literal prefix:

```json
{
  "mcpServers": {
    "assets": {
      "command": "node",
      "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-s3/lib/cli.js"],
      "env": {
        "S3_BUCKET": "my-assets",
        "S3_REGION": "ap-northeast-2",
        "S3_AUTH": "profile",
        "S3_PROFILE": "development",
        "S3_PREFIX": "project-a/",
        "S3_LOCAL_ROOT": "D:/transfers"
      }
    }
  }
}
```

For a compatible endpoint, use these connection variables in the same entry:

```json
{
  "S3_BACKEND": "compatible",
  "S3_BUCKET": "my-assets",
  "S3_ENDPOINT": "https://storage.example.com",
  "S3_REGION": "us-east-1",
  "S3_AUTH": "static",
  "S3_ACCESS_KEY_ID": "your-access-key",
  "S3_SECRET_ACCESS_KEY": "your-secret-key"
}
```

Use the signing region required by your storage service. Static keys are stored in the local catalog and registered client configurations; profile/default providers avoid copying their underlying credentials into entries. Previews mask key and token fields; **Print entry** intentionally includes saved credentials for copying.

| Variable | Behavior |
| --- | --- |
| `S3_BACKEND` | `aws` (default) or `compatible` |
| `S3_BUCKET` | Required general-purpose bucket name; no ARN/access point/directory bucket |
| `S3_REGION` | Explicit signing region; AWS can resolve it from its SDK configuration |
| `S3_ENDPOINT` | Required only for compatible mode; HTTP(S) root URL without user info, path, query or fragment |
| `S3_AUTH` | `default`, `profile`, `static`; AWS defaults to `default`, compatible requires an explicit choice |
| `S3_PROFILE` | Required for `profile`; SDK credentials remain refreshable |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | Static authentication only; access key and secret required, token optional |
| `S3_PREFIX` | Literal allowed key prefix, default empty; never automatically prepended |
| `S3_READONLY` | `true` blocks remote writes/uploads/deletes; default `false`; downloads remain allowed |
| `S3_LOCAL_ROOT` | Existing local transfer directory; omitted disables upload/download |
| `S3_FORCE_PATH_STYLE` | `true`/`false`; AWS default false, compatible default true |
| `S3_CA_FILE` | Custom trusted CA PEM file; TLS certificate verification remains enabled |
| `S3_CHECKSUM_MODE` | `WHEN_SUPPORTED` (default); compatible mode can explicitly select `WHEN_REQUIRED` |
| `S3_ALIAS`, `S3_DESCRIPTION` | Optional connection description |

Mixed or partial authentication settings fail validation. A compatible endpoint never implicitly selects the machine's AWS credential chain. If you explicitly choose `default` or `profile`, those credentials are used for that endpoint. SDK endpoint environment overrides are disabled; the registered endpoint controls routing. HTTP is accepted only when explicitly present in the endpoint URL.

| Limit variable | Default | Maximum |
| --- | ---: | ---: |
| `S3_MAX_LIST_ITEMS` | 100 | 1,000 |
| `S3_MAX_READ_BYTES` | 65,536 | 1,048,576 |
| `S3_MAX_WRITE_BYTES` | 262,144 | 1,048,576 |
| `S3_MAX_TRANSFER_BYTES` | 536,870,912 | 536,870,912 |
| `S3_REQUEST_TIMEOUT_MS` | 30,000 | 300,000 |
| `S3_TRANSFER_TIMEOUT_MS` | 300,000 | 3,600,000 |
| `S3_MAX_CONCURRENCY` | 4 | 32 |

All limits are positive integers. Tool `limit` and `max_bytes` may lower the configured cap. Deadlines include queueing, SDK calls and response body consumption. Cancelling queued work prevents dispatch.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `s3_info` | none | Scope, limits, policies, capability status; works before configuration |
| `s3_list` | `prefix?`, `recursive?`, `limit?`, `cursor?` | One page of objects and common prefixes, next cursor |
| `s3_stat` | `key` | Size, ETag, metadata, version ID |
| `s3_read` | `key`, `max_bytes?`, `if_match?` | Bounded UTF-8 preview, byte count and truncation flag |
| `s3_write` | `key`, `text`, write options | Entire UTF-8 object creation/replacement |
| `s3_upload` | `key`, `local_path`, write options | Stream one local file to an object |
| `s3_download` | `key`, `local_path`, `if_match?` | Stream an object to a new local file |
| `s3_delete` | `key`, `if_match?` | One exact-key deletion request |

Write options: `mode`, `if_match`, `content_type`, `cache_control`, `metadata`. Metadata names use lowercase ASCII letters, digits, underscores or hyphens; values are printable ASCII, at most 2 KiB total. Replacement defines the entire object body and user metadata; it does not merge old metadata.

Every tool returns matching JSON text and `structuredContent`. Errors set `isError`. Mutation results include `outcome`: `applied`, `not_applied` or `unknown`. A timeout or lost response after dispatch can be `unknown`; inspect the object before attempting another mutation. Writes/deletes use one SDK attempt, reads at most three. There is no unconditional fallback after rejected conditions.

### Object writes and deletion

- `create` (default) sends `If-None-Match: *` and refuses an existing object.
- `replace` requires one exact `if_match` ETag and sends `If-Match`.
- `upsert` explicitly allows unconditional overwrite and rejects `if_match`.

Read/stat the full object before replacing it; a truncated preview is insufficient for preserving its full content. ETags are opaque conditions, not guaranteed hashes or revision counters. Identical content or metadata-only changes can retain an ETag. [AWS conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)

Delete operates on one literal key, optionally with `if_match`. `*` has no wildcard meaning. A successful deletion does not prove that the key previously existed or that all historical versions are gone. Returned version IDs and delete markers are preserved. There is no version-ID input for permanent historical deletion. [AWS DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)

### Keys, pagination and text

Keys are **full bucket-relative strings**, including any configured prefix. With `S3_PREFIX=project-a/`, pass `project-a/file.json`. Spaces, Unicode, `%2F`, repeated slashes, `..` and backslashes are not normalized or decoded. Prefix matching is literal: `project-a` also matches `project-ab`, while `project-a/` does not.

Listing defaults to delimiter `/`; `recursive=true` omits it. Common prefixes and real objects such as zero-byte `folder/` keys are distinct. Cursors are authenticated, bound to the connection and query (including page limit), and expire on server restart. Pagination is not a point-in-time snapshot when other clients modify the bucket.

Text previews request a byte range and also bound actual streamed bytes when a service ignores Range. Incomplete trailing UTF-8 characters are omitted from truncated previews. Invalid UTF-8, binary control bytes, non-text content types and compressed content require downloading. Text content types include `text/*`, JSON, XML, JavaScript, NDJSON, YAML and TOML. Missing content type is validated by bytes. No automatic decompression or base64 preview is performed.

Preview ranges must start at byte zero and have consistent length headers. A short partial response is marked as truncated even when it is below the requested byte cap. Full downloads reject partial HTTP responses instead of treating them as complete objects.

### Local transfers

Local paths may be relative to `S3_LOCAL_ROOT` or absolute within it. Parent directories must already exist. Real-path checks reject symlink/junction escapes. Credential/configuration names (`.aws`, `.ssh`, `.codex`, `.claude`, `.cursor`, `.config`, `.env*`, MCP JSON files) and private-key extensions are protected. Uploads require regular files with a single hard link.

Downloads count actual bytes, write an adjacent private temporary file, fsync it and create the destination through a non-replacing hard link. Cancellation is checked again after fsync and immediately before creating the final link. Once that final filesystem operation has started, cancellation cannot undo a successful commit. Existing destinations, including files created during transfer, are kept. The filesystem must support hard links. Interrupted transfers remove their temporary files.

Keep upload source files unchanged during transfer. File-size and timestamp checks detect common changes but do not provide a filesystem snapshot. Local directories must be trusted against concurrent hostile renaming; portable Node filesystem APIs do not provide a complete sandbox against another local process. Remote object keys are never used as implicit local paths.

## Compatibility and scope

The first version uses the S3 data API, with no provider-specific API. For AWS, conditional behavior is documented; arbitrary compatible services remain **unverified** until tested. A successful read-only connection check cannot establish that a compatible service enforces `If-Match` or `If-None-Match`. It could ignore these headers while returning success. Verify create conflicts and stale-ETag writes/deletes on a dedicated test prefix before relying on these conditions.

Checksum handling defaults to `WHEN_SUPPORTED`. `WHEN_REQUIRED` is an explicit compatibility setting, never an automatic fallback after an error. [AWS SDK checksum settings](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html)

No bucket administration, multipart/resume, bulk/recursive deletion, version history management, copy/move, presigned URLs or provider-specific authentication is included. File transfers are capped at 512 MiB.

## Memory and process lifetime

The AWS SDK and the read/write clients load on the first storage operation. Startup, tool listing and `s3_info` do not load them. Concurrent first requests share initialization; default/profile credentials load their providers when needed, while static credentials skip the aggregate provider package. Custom CA files are still read and validated for accessibility at startup.

Previews are size-limited and transfers stream through bounded buffers. Oversized text is rejected before allocating its UTF-8 upload buffer. Incoming Buffer chunks are reused for previews and downloads. Buffers become eligible for garbage collection after use; Node need not return all allocated memory to the OS immediately.

After first use, SDK modules and credential providers remain loaded, and HTTP connections are reused until closed by the transport, peer or server shutdown. There is no idle worker termination or forced garbage collection. This avoids repeatedly rebuilding authentication and transports during ongoing work, but the first operation pays SDK initialization cost. Shutdown cancels outstanding work and destroys the clients; closing during initialization prevents a late request.

The concurrency limit bounds running operations, not the count of waiting requests; queued calls retain their inputs until served, cancelled or timed out. Each MCP connection and any npm/npx wrapper have separate memory costs. Restart the MCP process after updating to apply these changes.

## Development

Run these commands from a source checkout:

```sh
npm ci
npm run build
npm test
npm pack --dry-run
```

Tests use a local HTTP fixture with the real AWS SDK, an MCP client and isolated configuration files. They do not contact AWS or use real credentials. Real AWS and compatible-service acceptance remain separate release checks. The source checkout's `README_DEV.md` contains the acceptance checklist; see [CHANGELOG.md](./CHANGELOG.md) for release history.
