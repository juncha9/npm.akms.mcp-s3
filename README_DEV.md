# Development and release checks

## Release guard and package order

Run `npm run prepublishOnly` to inspect every publish prerequisite without publishing. `npm publish` runs the same `node scripts/release-guard.mjs` gate. It requires a clean `git status --porcelain`, a package version newer than the configured registry's `latest`, matching `SERVER_VERSION` (servers only), and five registration copies matching the DB baseline. Metadata uses a fresh temporary cache. Any lookup failure, including E404, or a missing `latest` tag blocks release. All five sibling checkouts are needed for release comparison; normal builds and installed packages do not need them.

The DB registration directory is the baseline. Run `node scripts/sync-registration.mjs` from the DB checkout after common changes. The launcher keeps its own adapters and its `prompter.ts` import is adjusted for `launcher/prompter`. Keep the five development-only `scripts/release-guard.mjs` copies identical.

Release in this order:

1. Publish `@akms/mcp-ssh` with AKMS registry protection first, after its tests, build, package inspection, reviewed commit and release gate pass.
2. Raise `@akms/mcp-wsl`'s SSH dependency minimum to that published protected release, remove ranges permitting SSH 0.1.9, and refresh its lockfile and local dependency. WSL's release gate calls the installed SSH guard against `.akms/mcp` reads and writes; the current SSH 0.1.9 must fail, regardless of the WSL version.
3. Validate and publish WSL, then the DB and S3 servers. Align each manifest, lockfile and `SERVER_VERSION`, synchronize registration, and commit reviewed release changes before running the gate.
4. Publish the optional `@akms/mcp` launcher last, once every child can be installed from npm.

The guard never commits, installs dependencies or publishes. `npm pack --dry-run` inspects contents without invoking this publish-only gate.

Build with Node.js 22+ and npm. `npm ci`, `npm run build`, `npm test`, and `npm pack --dry-run` require no storage credentials. Run configuration locally with `node lib/cli.js config` until the first registry release exists.

[README.md](./README.md) is the reference for supported behavior, configuration and limits. This document records implementation constraints and release checks; [CHANGELOG.md](./CHANGELOG.md) records changes.

## Code map

- `src/profile.ts`: environment validation, limits and safe connection summary.
- `src/client.ts`: lazy SDK/credential loading, fixed endpoint settings, TLS and separate read/mutation clients.
- `src/policy.ts`, `src/local-files.ts`, `src/queue.ts`: scope, conditions, local I/O and cancellation-aware concurrency.
- `src/store.ts`: all S3 operations, pagination cursors, bounded reads and streamed transfers.
- `src/response.ts`: preview range consistency and full-download response validation.
- `src/server.ts`: eight MCP schemas, annotations, instructions and dual text/structured responses.
- `src/modules/manage/`: setup form, connection test progress and client configuration adapters.
- `tests/fixture.ts`: local S3 HTTP fixture. It tests our SDK request/response integration; it is not evidence that a third-party service implements the same semantics.

## Design constraints

- Keep one bucket per connection. Endpoint, region, credentials and optional prefix come from the configured profile, never from tool arguments.
- Route all object I/O through `S3Store` so library calls and MCP tools share the same policy checks. MCP annotations are hints, not access controls; do not expose the raw SDK client as a bypass.
- Preserve object keys as literal strings and validate local transfer paths separately. An object key must never implicitly become a local filesystem path.
- Use native conditional requests for create/replace/delete. A HEAD followed by an unconditional write cannot provide the same concurrency protection. Do not retry mutations automatically or remove their conditions after an error.
- Keep connection checks read-only and scoped to the configured prefix. Do not require account-wide bucket listing, STS or HeadBucket, and report only the phases and permissions actually checked.

Multipart/resumable transfers remain deferred. A future implementation must address conditional completion, cancellation, AbortMultipartUpload and cleanup of leftover parts together. Bucket administration, bulk deletion and version-history management also remain outside the current scope.

## Memory review (2026-10-19)

Windows / Node 24.19.0, built library, one configured server, no npm wrapper: three fresh processes per build measured median Private Bytes of 73.32 → 49.51 MiB and RSS of 89.58 → 76.89 MiB after deferring SDK initialization. The original private-memory samples ranged from 53.68 to 73.40 MiB, so these are local observations, not a fixed budget. Neither build made a storage request in this startup comparison.

A separate local HTTP fixture ran in a child process so fixture payloads did not count toward client memory. Three rounds uploaded and downloaded a 64 MiB file using static fixture credentials and `WHEN_REQUIRED`, with no real storage access. The highest sampled client RSS was 155.21 MiB before and 138.34 MiB after removing redundant copies (10 ms samples). After each round, explicit diagnostic GC returned client ArrayBuffer allocation to about 0.22 MiB before and 0.16 MiB after; retained heap did not grow by the transferred file size. This did not reproduce a persistent transfer-buffer leak. Forced GC was used only to distinguish live allocations from garbage; production code never forces GC or promises immediate OS memory return.

The first local HEAD request took 16.9 ms before and 61.8 ms after deferring initialization in that transfer sample. This moves roughly 45 ms from startup to the first request on this machine; initialization is not repeated after idle periods. SDK modules remain cached after use. Shared initialization, cold cancellation/shutdown, all credential modes, and ESM/CJS builds are covered in `tests/startup-loading.test.ts`. Existing tests cover stream errors, checksum modes, conditional writes and interrupted-transfer cleanup. These fixtures do not certify real-provider behavior or prove the absence of leaks under every workload.

## Real-provider acceptance before publishing

Use a dedicated test bucket/prefix on AWS S3 and at least one intended S3-compatible service. The user running the checks must explicitly configure those test credentials and authorize the test writes. No test automatically reads workstation S3 credentials or writes to a real service.

1. Run `--check`; confirm it only lists the configured bucket/prefix.
2. Use unique keys under the test prefix. Confirm create succeeds, a repeated/concurrent create conflicts, stale ETag replacement fails and current ETag replacement succeeds.
3. Confirm conditional delete rejects a stale ETag; inspect version IDs and delete markers on a versioned bucket. Record each created version and marker for exact cleanup through the provider's administrative tools.
4. Round-trip binary files and Unicode/special-character keys, paginate objects/common prefixes, read empty and truncated UTF-8 objects, and confirm read-only/prefix restrictions.
5. Verify `WHEN_SUPPORTED` checksums and any explicitly required `WHEN_REQUIRED` setting. A service returning success after ignoring a condition does not pass acceptance.
6. Record service/version, addressing mode, region, checksum mode and conditional-operation results. Preserve secrets outside logs and reports. Remove only the exact test objects/versions recorded in this run.

Do not publish a claim of verified provider compatibility until these checks have been completed. Never retry an `unknown` mutation blindly.

## Packaging

Keep package.json, both package-lock root versions and `SERVER_VERSION` aligned. `prepack` rebuilds source. The `files` allowlist matches the sibling MCP packages: `lib`, README, CHANGELOG and LICENSE; npm also includes package.json. Source maps remain part of `lib`. `.npmignore` records exclusions for source, tests, development configuration and repository-only documentation, including DESIGN.md and README_DEV.md. Check the actual file list with `npm pack --dry-run` before publishing. The unified launcher must be released after the first S3 package is resolvable from its configured registry.

Shared UI/config writer files were copied from the reviewed sibling packages to avoid pulling database or SSH dependencies into S3. Their corresponding regression tests are included here. Coordinate future fixes across the copies.

## Registration code

The local `src/modules/registration` copy is bundled into this package. It needs no launcher or sibling checkout at build or runtime. The sibling DB checkout maintains the shared files; its `node scripts/sync-registration.mjs` command updates development copies. Keep schema version 1 compatible across releases and test standalone registration before publishing.

## Link the development runtime

The server installation is independent of the active Node version: `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. After building the checkout, use npm's global layout with this explicit prefix; a plain `npm link` in the default Node prefix is not discovered as the managed runtime.

From this checkout in PowerShell:

```powershell
npm run build
$akmsRuntime = if ($env:AKMS_MCP_HOME) { Join-Path $env:AKMS_MCP_HOME "runtime" } else { Join-Path $env:USERPROFILE ".akms/mcp/runtime" }
npm install --global --prefix $akmsRuntime .
node lib/cli.js config
```

For macOS/Linux, use `npm install --global --prefix "${AKMS_MCP_HOME:-$HOME/.akms/mcp}/runtime" "$PWD"` after building (supported by this package). The package is linked into the prefix without moving the source checkout. Runtime shows **linked development checkout**, hides Update and skips version-update prompts. Rebuild the source to change the running code, then reconnect AI clients. Use Runtime > Use for existing connections to migrate older npm/npx launch paths.

## Session-server compatibility

Setup reads registry versions 1 and 2. New catalogs start at version 2 with `defaultMode: "catalog"`; their first connection of each kind creates its session launch. Existing version 1 catalogs require the confirmed Runtime switch. Existing version 2 catalogs without `defaultMode` retain individual mode for kinds without explicit session state. Per-kind choices override the default, and rollback keeps version 2 so older setup cannot recreate individual entries. Server `--catalog` readers accept both versions without locks or writes. The common `catalog.ts` has no dependency on setup or the optional helper. Include it in the five-copy release comparison. `registration-session.test.ts` covers migration/rollback, backup failure, name budgets, external edits, replacement ordering and bundle startup coverage.

During active MCP development, build a disposable source copy and validate it before replacing live `lib` files. The normal build removes `lib`; running it beneath a connected MCP can break active sessions.

Registry migrations are ordered in `registry.ts`: `v1_to_v2`, then `catalog_default`. `needsMigration`, `planMigration`, and `applyMigration` support scripted review/application; the plan is rechecked under the normal lock. Session planning and state transitions are shared with `planSession`/`applySession`, while one outer mutation preserves the pre-migration backup. `setDefaultMode("individual")` and `setDefaultMode("catalog")` change only the future-kind default after migration. An explicit individual marker remains current format. `registration-migration.test.ts` covers migration, no-op repetition, backup, stale plans, external edits, missing runtimes, rollback preservation and menu approval. Include `migration-menu.ts` in common-file synchronization.
