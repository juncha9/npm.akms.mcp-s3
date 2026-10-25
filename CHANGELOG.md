# Changelog

## [0.3.1] - 2026-10-26

### Verification

- Stabilize Windows test cleanup: temporary test directories are removed with one bounded asynchronous retry budget for transient file locks, while persistent errors still fail. Tests only; the published package changes only its version.
- 0.3.0 was committed but never published to npm; 0.3.1 is the first published 0.3 release.

## [0.3.0] - 2026-10-26

- Detect older registry formats in standalone config and the helper menu. Add reviewed, ordered migrations with default-No approval, script APIs, complete pre-migration backup, rollback preservation and post-apply startup checks. Runtime can change the default for future kinds without changing existing modes.

- Start new registries in version 2 session mode. Register/Add/Import create per-kind bundles automatically; missing runtimes keep imported legacy entries until installation and Sync. Existing v1 migration and v2 per-kind rollback choices are preserved.

- Add session servers (default for new catalogs, opt-in migration for existing version 1 catalogs): one direct-Node `akms_<kind>` entry per client session, connection-prefixed tools, registry version 2, reviewed migration and rollback, and startup tool coverage checks.
- Preserve one atomic `registry.previous.json` revision per catalog-changing operation; keep externally edited client entries for Sync and retain old entries until replacements are verified.
- Validate connection-name budgets; document credential location and recovery in session mode. Show runtime paths in startup failures, accept string protocol versions, and explain file-lock update failures.

- Check MCP startup after saves, runtime conversion and Updates; add an on-demand Updates screen and default registration removal to No.

- Document plaintext catalog credentials, platform permissions, transfer-guard limits and recovery; show one privacy notice during Register review and a catalog notice in --help.
- Keep custom-command edits and host-key saves independent of the managed runtime; continue with a still-usable installed runtime after an update failure.

- Install managed server runtimes under `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`, independent of Node versions. Convert existing npx and global paths through Runtime; preserve development links.
- Offer older-runtime updates before Add/Edit and check installation before host-key saves. Include the last npm error lines without ANSI controls, and recognize Unix npm JavaScript paths while skipping version-manager shims.

- Generate direct Node launches using the dedicated runtime installation instead of npx. Install the latest runtime on first Add/Edit when missing; reuse installed versions with update prompts when the setup package is newer. Runtime converts existing standard entries together, preserving connection values, custom commands and external edits; linked development packages are protected.

- Clarify Sync choices with numbered AKMS/service versions, highlighted differences, wrapped values, and explicit apply destinations.

- Separate terminal menu, comparison and result screens; wait for acknowledgement before returning, while keeping piped commands unchanged.

- Keep all configuration menus visible; Add requires at least one registered AI service.
- Summarize registration/sync results, show only differing fields during review, and distinguish pending imports from shared settings conflicts.

### Changed

- Discover earlier client settings before registration, merge matching sync copies on Apply, and preserve differing versions for review.
- Add standalone `register` and `sync` commands and a persistent shared connection catalog. Save once to apply a connection to all registered AI services without installing `@akms/mcp`.
- Import existing client entries with explicit conflict choices; preserve external edits, retry partial failures and retain old names until renames succeed. Honor `CODEX_HOME`.

## 0.2.1 — 2026-10-19

### Documentation

- Add minimum AWS and S3-compatible configuration examples to README, distinguishing explicit credentials, existing credential providers and optional local file transfers.
- Set the package repository, homepage and issue links to `juncha9/npm.akms.mcp-s3` on GitHub.

## 0.2.0 — 2026-10-19

### Changed

- Align the package, CLI and MCP server versions with the 0.2.0 MCP release family, retaining the S3 CRUD implementation, review fixes and packaging rules documented below.
- Defer AWS SDK/client construction until the first storage operation. Concurrent first requests share initialization; static credentials do not import the aggregate credential-provider package. Preserve custom CA validation at startup and cancellation/shutdown during loading.
- Check UTF-8 text size before allocating its upload buffer, and reuse incoming Buffer chunks for previews and downloads instead of copying every chunk. Keep conditional writes, retry limits and transfer streaming unchanged.
- Add fresh-process ESM/CJS checks for loading, oversized writes, concurrent requests, cold cancellation/shutdown and isolated default/profile credentials. Document startup and repeated-transfer memory measurements and first-request initialization cost.

## 0.1.2 — Unreleased

### Changed

- Align npm packaging with the sibling MCP packages: add `.npmignore` and limit the `files` allowlist to `lib`, README, CHANGELOG and LICENSE. Keep source maps with the compiled output; retain DESIGN.md and README_DEV.md only in the source checkout.
- Update development documentation references to avoid linking from the published README to an excluded file.

## 0.1.1 — Unreleased

### Fixed

- Validate preview range/length headers and correctly mark short partial responses as truncated. Refuse partial HTTP responses for full downloads instead of committing incomplete files.
- Recheck cancellation during download fsync and immediately before the local file commit. Classify MCP string cancellation reasons as cancellation without exposing their contents, preserving mutation outcome uncertainty after dispatch.
- Reject non-regular upload sources before opening them; use nonblocking/no-follow open flags where available and verify the opened file identity.
- Check for same-name connections at Save time and refuse stale edits when the entry changed while the form was open.
- Preserve additional client options when editing JSON stdio entries; explicit copy/overwrite still replaces the destination entry completely.
- Add regression tests reproducing partial responses, cancellation during commit, concurrent configuration changes and JSON option loss.

### Documentation

- Preserve the design decisions and deferred work in an English DESIGN.md. README remains the current behavior and configuration reference; README_DEV records implementation constraints and release checks.

## 0.1.0 — Initial implementation (unpublished)

### Added

- One-bucket AWS S3 / S3-compatible MCP stdio server and ESM/CJS library exports.
- Eight tools: connection information, paginated listing, stat, bounded UTF-8 reading, text writing, streamed upload/download and single-key deletion.
- Create-only default writes, ETag-guarded replacement/deletion, explicit upsert, version/delete-marker results and mutation outcome classification without automatic mutation retries.
- Validated authentication modes, refreshable SDK credential providers, fixed endpoint/bucket routing, literal prefix and read-only policies, custom trusted CA and explicit checksum compatibility mode.
- Configurable byte, concurrency and deadline limits; cancellation removes queued work and interrupts active streams.
- Local transfer-root containment, credential/config path protection, upload change checks and non-overwriting temporary-file download commits.
- Interactive configuration for Claude Code, Codex, Claude Desktop and Cursor; animated read-only connection checks, result pause and cross-client copy with overwrite confirmation.
- Reviewed JSON/TOML writers with unrelated-content preservation and Claude Code replacement recovery.
- Local HTTP protocol, MCP transport, CLI, configuration and shared UI regression tests. Real-provider acceptance is pending; no provider compatibility certification is implied.
