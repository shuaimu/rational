# RobinLab MakoDB migration

Status: **migration complete**. The source code uses MakoDB for backend persistence and authenticated browser replication. All 151,473 source documents were independently verified before publication. Normal compute now runs in Mako Cloud functions; only the Vite frontend runs locally. The native server and its database are retained for explicit rollback. See [serverless runtime](serverless/README.md) and [compute rollback](serverless/cutover-runbook.md). Supabase is obsolete.

The deployed worker and contention fixes allowed staging to finish. The migration tool splits oversized import files to work around the internal RPC limit addressed by [mako-cloud PR #3](https://github.com/makodb/mako-cloud/pull/3). All seven isolated Chrome replication checks pass. Live API reads, option actions, transaction updates, Excel replay/deduplication, SnapTrade preview, authorization, restart replay, and rollback after accepted writes have passed. Six live-cloud auth/RxDB checks also pass, including exact full-data replication, offline reopen, reconnect, deletion catch-up and sign-out. All synthetic writes are cleaned up and the final export matches the source and financial reports. Fresh Chrome sign-in, all seven application pages, transaction filtering, and persisted-session reload passed at version 26. These are storage-migration results. The subsequent compute migration replaces the native hourly timer with one Mako dispatcher; see the serverless evidence for current versions and scheduler state. See `qualification.md` for the evidence and retained backup details.

`environment.json` identifies the isolated `robinlab` environment created inside Rational. It contains no credentials. Never substitute Rational production when a setup command fails.

## Developer CLI

The current prepared CLI can authenticate without putting a password in command history:

```sh
node /tmp/robinlab-mako.j724da/platform/packages/cli/dist/main.js auth login \
  --endpoint https://cloud-test.makodb.com --profile robinlab --email msmummy@gmail.com
```

The official CLI keeps a session (the current developer login is not renewable) in its protected credential store. Passwords and tokens do not belong in this repository or chat.

To rebuild if the temporary checkout has been removed, use the platform revision in `qualification.md`:

```sh
gh repo clone makodb/mako-cloud .local/mako-platform
git -C .local/mako-platform checkout b9daccf932360335361f53a563303ec3a3ffbe37
cd .local/mako-platform
npm ci --ignore-scripts --workspace @mako-cloud/cli --include-workspace-root
npm install --no-save --ignore-scripts --workspaces=false @types/node@24.10.1
npm run build --workspace @mako-cloud/cli
node packages/cli/dist/main.js auth login --endpoint https://cloud-test.makodb.com --profile robinlab
```

## Authoritative source inventory

Run from the repository root with unique output names. Existing output files are never overwritten. Artifacts contain private portfolio data, have mode 0600, and must remain in ignored storage.

```sh
python3 scripts/mako_inventory.py snapshot --sqlite robinlab.db \
  --out .local/mako-migration/sqlite-snapshot.json
```

The user confirmed that Supabase is obsolete. No Supabase export or connectivity is required. The snapshot uses a read-only SQLite transaction and checks normalized hashes, identifiers, references, and occurrence counts. It does not freeze other writers or transfer credentials. Cutover still requires a final snapshot after pausing every writer, hosted tests, financial parity, and rollback rehearsal.

The comparison utility accepts a format-1 MakoDB export (`source: "mako"`, tables mapped to `{columns, rows}`). It rejects missing tables, unknown fields, duplicate keys, broken references, changed fields, and altered snapshot hashes. Credential values and raw provider errors are excluded from the ordinary inventory. Credentials are transferred in a separate protected artifact; historical free-form provider errors become null to avoid copying API keys or signed URLs. Financial values are not rounded.

## Package, rehearsal, and cutover

Use a **new directory** for each source snapshot. All artifacts are private and ignored by Git. `snapshot` uses SQLite's backup API, checks database integrity, and then inventories the frozen copy. The initial command ID derives from the immutable source manifest. All portfolio partitions are hashed; replay never replaces a different existing document. The original SQLite file is never modified by these tools.

```sh
cargo build
python3 scripts/mako_migrate.py snapshot --sqlite robinlab.db --out .local/mako-migration/RUN
# Offline: merge the separate credentials into bounded private partitions.
target/debug/robinlab mako-pack .local/mako-migration/RUN
python3 scripts/mako_cloud.py seal .local/mako-migration/RUN
node frontend/scripts/mako-validate-package.mjs .local/mako-migration/RUN
target/debug/robinlab mako-verify-source .local/mako-migration/RUN
target/debug/robinlab mako-financial .local/mako-migration/RUN .local/mako-migration/RUN/financial-current.json
node frontend/scripts/mako-verify-wasm.mjs .local/mako-migration/RUN
python3 scripts/mako_migrate.py rollback .local/mako-migration/RUN \
  --cloud-export .local/mako-migration/RUN/rehearsal-export.json \
  --out .local/mako-migration/RUN/rollback.sqlite
```

Before final packaging, stop every legacy SQLite writer and scheduler, verify no process retains the database, then make a fresh snapshot. Retain the original binary/checkout and the frozen backup for rollback. Never use a rehearsal package as the final source while SQLite writers are still active.

Bulk operations use the official CLI (pass its executable JavaScript path with `--cli`). `preflight` exports **all eight destination collections** without mutating documents. It accepts only exact package records and the three explicitly recorded content-addressed qualification orphans. Any other record, changed value, different head, or duplicate key stops the migration. Each command saves its job ID in `bulk-jobs.json`; repeat the same phase to resume a queued/running job. Do not edit sealed files or change conflict strategy. A failed/expired job requires a reviewed new preflight; partial rows remain immutable and must match the package. Preflight seals the missing-record file checksum. Files whose 32-row batches could exceed the RPC budget are divided into deterministic, private parts of at most 200,000 bytes, with separate resumable job IDs. A changed part or missing-record file is rejected before upload. Successful jobs may retain dependency-retry warnings; their final state and failed-row counts determine completion.

```sh
python3 scripts/mako_cloud.py preflight .local/mako-migration/RUN --cli CLI_PATH
python3 scripts/mako_cloud.py stage .local/mako-migration/RUN --cli CLI_PATH --allow-cloud-writes
python3 scripts/mako_cloud.py verify .local/mako-migration/RUN --cli CLI_PATH
# This refuses publication without successful source financial and staged-data reports.
target/debug/robinlab mako-publish .local/mako-migration/RUN
# Export with all writers stopped: portfolio is pinned, independent caches must be quiescent.
target/debug/robinlab mako-export .local/mako-migration/RUN/cloud-export.json
python3 scripts/mako_inventory.py compare \
  --sqlite-snapshot .local/mako-migration/RUN/inventory.json \
  --destination-export .local/mako-migration/RUN/cloud-export.json \
  --out .local/mako-migration/RUN/comparison.json
target/debug/robinlab mako-check-export .local/mako-migration/RUN .local/mako-migration/RUN/cloud-export.json
```

Only after all reports pass should the new API start on port 3000 and the browser be allowed to write. Verify a reversible write, restart, command replay, and browser catch-up before resuming one scheduler. Production API startup refuses a missing head and has no SQLite fallback.

### Rollback after cloud writes

Stop the MakoDB backend and scheduler first. Export the current cloud state using `mako-export`, then use `scripts/mako_migrate.py rollback` with that export and the retained source snapshot. This builds a **new** SQLite database, including current private mappings, credentials, balances, snapshots, and accepted transactions, and checks the result against the export. Never restore the old pre-cutover snapshot over accepted cloud writes. Review the generated verification report, then start the retained legacy checkout against the rebuilt database; keep both cloud state and backups intact. SQLite schemas without AUTOINCREMENT derive new IDs from remaining rows, as the legacy application did; MakoDB counters remain in the protected export.

Rollback after hosted writes has also passed: a quiescent export containing all 13 journaled smoke transactions rebuilt an isolated SQLite database, matched the cloud inventory, and served the updated transaction through the retained legacy binary. Actual post-cutover rollback still requires a fresh quiescent cloud export.

## Synthetic gateway qualification

`functions/qualify` only handles synthetic `q_` records in `qualification_heads`, `qualification_parts`, and `qualification_large_parts`. It denies callers other than the configured active worker, creates parts immutably, checks every part before attempting a conditional head mutation, and assigns a fresh service request ID to every internal call.

All three schemas, denied policies, identities, scoped keys, function secrets, and the JWT-verified gateway are deployed. Non-secret metadata is in `qualification/provisioned.json`. Hosted authentication, CAS, replay, revocation, and a 3 MiB benchmark passed; see `qualification.md` for measured limits and remaining work. No real portfolio data belongs in these collections.

To repeat the hosted qualification:

```sh
node frontend/scripts/mako-qualify-hosted.mjs \
  --identities .local/mako-migration/qualification-identities.json \
  --public-key .local/mako-migration/public-key \
  --report .local/mako-migration/hosted-qualification-unique.json \
  --allow-synthetic-writes --benchmark
```

This creates synthetic `q_` records and signs out only the application sessions it creates for the test run. Use a new report path each time. A successful report still has `cutoverReady: false`; reconciliation, financial parity, replication validation, and rollback remain required.

```sh
python3 -m unittest discover -s scripts/tests -v
node --test scripts/tests/mako-qualification.test.mjs
```

## Runtime and frontend development

`mako/runtime.json` and `frontend/src/api/mako-config.json` contain public scope metadata and the publishable project key. They contain no service credential. Backend configuration defaults:

- `MAKO_CONFIG_PATH=mako/runtime.json`
- `ROBINLAB_RUNTIME_DIR=.local/mako-runtime` (0700)
- `MAKO_WORKER_SESSION=.local/mako-runtime/worker-session.json` (0600)
- `HOST=127.0.0.1`, `PORT=3000`

The worker session is a renewable **application-user** session, distinct from CLI developer login. One process owns its file lock. Renewal rotates and persists the refresh token before reuse; definitive revocation stops operations and the scheduler. Bootstrap once with `frontend/scripts/mako-worker-login.mjs PRIVATE_IDENTITIES NEW_SESSION_FILE`; it refuses overwriting an existing session. Keep application passwords outside source control. The privately provisioned owner sign-in is recorded locally in `.local/mako-runtime/owner-login.txt`; it is separate from the MakoDB developer account password.

`cargo run` starts the new API only after migration. `cd frontend && npm run dev` serves port 5173 with relative `/api` proxying. Browser reads use scoped RxDB transport collections, durable pull checkpoints, a shared live stream, and an atomically selected complete manifest generation. Incomplete new versions retain the last verified view. Protected data is cleared on sign-out, revocation, or scope change. An offline reopen can use a previously verified owner cache. Mutations attach owner authentication and persistent retry IDs and wait for the returned portfolio version to replicate.

The backend owns the only SnapTrade timer. `SNAPTRADE_SYNC_INTERVAL_MINUTES=0` disables it; the default is 60. A protected journal retains a pending scheduled command across restart, and a committed replay does not fetch or import brokerage activity again. A dirty price-cache marker repairs latest prices after an interrupted history/latest update. Cache data is disposable; portfolio publication remains atomic.

Wasm initializes independently of persistence. No Supabase client, polling, seed hydration, or browser SnapTrade timer remains. Historical Supabase support files are obsolete archives.

## Verification

```sh
cargo test --workspace
python3 -m unittest discover -s scripts/tests -p 'test_mako*.py'
node --experimental-strip-types --test scripts/tests/*.test.mjs
node frontend/scripts/mako-local-integration.mjs
cd frontend && npm run lint && npm run build
```

The local integration harness uses the actual auth adapter, RxDB, Dexie, and application materializer with deterministic HTTP and in-memory IndexedDB. It covers missing partitions, offline reopen, renewal coalescing, version-based deletion, checkpoint rebuild, definitive revocation, scope changes, and concurrent sign-out. It complements the required real-browser smoke checks.

Regenerate all Wasm targets when shared calculation code changes:

```sh
wasm-pack build crates/wasm --target web --out-dir ../../frontend/src/wasm
wasm-pack build crates/wasm --target web --out-dir pkg
wasm-pack build crates/wasm --target nodejs --out-dir pkg-node
```

### Current frozen migration

The final snapshot is `.local/mako-migration/final-20260925`; the legacy backend
and scheduler are stopped. Every staged collection was verified exactly, the
initial portfolio head was published, and a committed export matched the source
and financial checks. All known bulk jobs are terminal and no importer is running.
The protected `api-smoke-journal.json` confirms every synthetic transaction was
removed. `final-clean-cloud-export.json`, `final-clean-comparison.json`, and
`final-clean-cloud-export.financial-verification.json` verify the cleaned version
26 against the frozen source. See the latest dated section
of `qualification.md` for verified status; older entries describe prior rehearsals.

For terminal bulk-job failures, `scripts/mako_stage_recover.py DIRECTORY --cli
PATH --profile robinlab --login-email EMAIL --allow-cloud-writes` reconciles fresh
cloud exports against the sealed package, then imports only exact missing rows.
It refuses active previous imports, collisions, changed artifacts, and a live head.
Saved uploads and unconfirmed jobs resume under their original job IDs. Repeated
terminal import failures trigger cooldowns between CLI commands, increasing from
30 seconds to five minutes; successful batches reset the cooldown. Do not suspend
the process during a CLI command, because its timeout continues to elapse.
Developer credentials are prompted privately and used only for CLI renewal; a
private temporary password file is removed on normal completion or error. If the
process is forcibly killed, remove its `.login-*` file from the private run directory.
The tool does not publish the head or start writers. Follow final verification and
publication steps only after `verified-staging.json` reports `complete: true`.

Browser-only replication checks use synthetic data on the isolated port 5174:
from `investment/frontend`, start the standalone fixture server with
`npx vite --host 127.0.0.1 --port 5174 --strictPort`, open
`http://127.0.0.1:5174/tests/replication.html`, and require all seven checks to pass.
The harness intercepts cloud requests and refuses to run on the application's port.
