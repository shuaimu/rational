# Migration qualification

The runtime has **not** been cut over. Hosted gateway/commit qualification is still required before replacing persistence.

## Verified on 2026-09-23

- Rational is the selected project, under the existing developer account.
- Created the isolated `robinlab` environment recorded in `environment.json`; console reports active, zero collections and zero functions. Existing production (13 collections, 3 functions) and development (0 collections, 0 functions) were left intact.
- Official adapter: `https://github.com/makodb/mako-rxdb`, package version 0.2.0, pinned commit `3a901406e674bf9d935b1f84798c772b9816e00c`. Installed from its HTTPS source archive, with archive integrity retained in `frontend/package-lock.json`. The public npm name returns 404; no private registry is required for this distribution.
- Import/configuration smoke check passed with RxDB 17.4.0 and RxJS 7.8.2; unsupported RxDB 16 is rejected. Browser adapter, auth, grouped live stream, and authorization-reset exports resolve.
- Authoritative contract: `makodb/mako-cloud`, commit `b9daccf932360335361f53a563303ec3a3ffbe37`, `api/openapi/mako-cloud-v1.yaml`, SHA-256 `83664a4895822a01c0833b75b0f6dce1c241fe89cec5f6c76560d1a0f63e3b39`.
- Official management CLI built from that platform revision. Its workspace-only install required adding `@types/node@24.10.1` to the temporary build dependencies. No platform source was changed.
- Source inventory completed without modifying SQLite: 11 accounts, 146 tickers, 7,804 transactions, 660 value snapshots, 91 split records, 77 latest prices, 38,107 historical prices, and 112,329 provider-log records at the captured snapshot. No orphan references, duplicate primary keys, unknown tables, or column discrepancies were detected.
- Read-only source inventory/comparison tests: 13 passed. Synthetic gateway handler tests: 7 passed. Malformed-credential redaction regression: 1 passed. These prove local behavior only, not hosted atomicity.
- Frontend lint and production build passed with the pinned SDK. Build retains the existing large-chunk warning.

## Verified on 2026-09-24

- Signed the official CLI into developer profile `robinlab`; authenticated environment, collection, auth-settings, and application-user metadata reads succeeded. The CLI reports a stored developer session (not renewable); credentials remain in its protected local store.
- Opened [mako-cloud PR #1](https://github.com/makodb/mako-cloud/pull/1) correcting the SDK installation command in the package README, user book, and console quickstart. A clean install of the official `v0.2.0` HTTPS release archive and public SDK imports passed; documentation validation passed.
- Reconfirmed the isolated `robinlab` environment is active and initially had no collections or application users.

## Resume on 2026-09-24

- Renewed the expired developer session through the official CLI.
- Retried `qualification_heads` with its original schema and ID; it became **active**. The prior internal identity-authority failure no longer blocks collection installation.
- Created `qualification_parts`, validated and activated version-1 empty-rule/default-deny policies on both collections, and configured only the localhost and loopback Vite development origins.
- Issued a public project key and a service key restricted to `qualification_heads` and `qualification_parts` with only `read`, `create`, and `update`. Initialized the environment signing key.
- Created and signed in separate owner, worker, and untrusted application identities. Generated application passwords and sessions are in protected ignored local storage; they are distinct from the developer-console password. No invitations or emails were sent. Public resource identifiers and exact scopes are in `qualification/provisioned.json`.
- Created the worker-ID function secret successfully. Before the service-key function secret could be attached, requests began returning empty HTTP 403 responses from Caddy. Subsequent homepage and environment-metadata requests also returned 403. This is distinct from the earlier collection-installation error; its cause is not yet established.
- [mako-cloud PR #1](https://github.com/makodb/mako-cloud/pull/1) is merged. The user reports that the documentation is awaiting online deployment.
- Added `frontend/scripts/mako-qualify-hosted.mjs`: a repeatable, synthetic-only hosted test runner for access denial, immutable staging, incomplete manifests, replay, concurrent head publication, direct-document denial, request bounds, session renewal, and revocation. It reserves private reports without overwriting them and omits tokens/upstream messages. Syntax checks and the existing seven local gateway tests pass. **Hosted tests have not run successfully; no hosted guarantees are claimed.**

## Hosted qualification on 2026-09-24

The deployment outage has cleared. Both function secrets are attached and `robinlab-qualify` is deployed with verified application JWTs. Current public metadata is recorded in `qualification/provisioned.json`; private credentials and reports remain under ignored `.local/mako-migration/`.

Gateway version 3 completed all eleven checks (`hosted-qualification-20260924-g.json`): distinct identities; worker-only access; immutable staging and replay; missing-partition rejection; lost-response recovery; exactly one winner for concurrent conditional head updates; direct-document denial; request bounds; renewal; and rejection after sign-out/revocation. One measured 3.6 KB staging call took 531 ms, publication 362 ms, and a head read 272 ms. These are individual observations, not latency guarantees.

Integration corrections: the function transport supplies `Cache-Control: no-store` and rejects application-supplied Cache-Control; service request IDs require the `req_` prefix. Denied document point reads intentionally return 404. The qualification handler and runner now follow those contracts.

A separate denied `qualification_large_parts` collection tests 32 KiB payloads. Sequential probes of 4, 8, 16, and 32 KiB succeeded. Parallel staging at concurrency four repeatedly returned upstream HTTP 503, with the allowlisted reason `document sequencer is unavailable`. The representative benchmark with serialized staging and concurrent reads passed (`hosted-qualification-20260924-l.json`). Initial sign-in has also intermittently returned HTTP 502 shortly after a deployment; a later independent sign-in succeeded.

The user confirmed Supabase is obsolete. Its unavailable endpoints are not a blocker. The obsolete frontend client, polling, seed/export commands, and dependencies have been removed; the transitional RxDB cache reads the Rust API.

## Pending

- Implement cloud repositories, authenticated replication, migration verification, and rollback before switching either runtime layer.
- Freeze all SQLite writers and capture a final consistent snapshot at cutover. The existing inventory is not a frozen cutover backup; the running legacy application continues to write.

No real portfolio records have been uploaded. SQLite remains the configured runtime source. Synthetic hosted checks do not establish migration readiness.

## Qualified implementation budget

**Go for dependent implementation; no cutover yet.** Version 6 passed all fourteen hosted checks. The 96-document, 3 MiB synthetic dataset took 45.145 seconds to stage serially (median 413 ms, p95 881 ms per call), and 17.802 seconds to read with concurrency four (median 578 ms, p95 1,257 ms). A publication validating sixteen partitions took 1.723 seconds. A typical changed partition plus bounded manifest path should require only a few calls; unchanged data must be reused.

Use at most 32 KiB UTF-8 payload per partition, a 30 KiB packing target, manifest fanout at most sixteen, serialized staging, and at most four concurrent reads. Keep each function invocation bounded; stage a large import across multiple calls. The tested deployment allows 1 MiB request/response, 1,000 ms CPU, 10,000 ms wall time, 128 MiB memory, and concurrency four. The application rejects a 32 KiB-plus-one-byte payload and requests over 210,000 bytes before persistence. These are conservative application limits and deployed configuration, not a claim about MakoDB's absolute maximum document size.

The live SQLite measurement contained about 2.8 MB of portfolio JSON (roughly 100 packed documents after structural overhead). A first complete download is therefore on the order of the measured 18 seconds, with subsequent loads using the local complete cache and changed partitions. This estimate excludes manifest traversal, network variability, and SDK replication overhead, which must be measured before cutover. Price history (~5.2 MB, 38k records) and provider logs (~14 MB, 113k records) use indexed pagination and are excluded from every portfolio load. Point-by-point initial migration of those independent records may take hours; resumability and progress reporting are required. These are request/storage costs, not a billing quote.

Parallel create allocation can return transient sequencer 503s, so production writes need bounded retries with unchanged mutation IDs and fresh per-call request IDs. A returned conflict still requires reloading and recomputing the operation. A definitive authorization failure must never enter that retry loop. The successful head race proves one conditional publication wins, not the availability of parallel staging.


## Application implementation and rehearsal — September 24

The repository gateway is active at version 5, bundle `sha256:a79edf759fb3229766c8d6861ee22ad27fbbc981a81236e360c8b54378771753`. Independent historical/latest prices, provider logs, and split-fetch state have active schemas, policies, and declared indexes. Hosted cache tests cover indexed pagination, owner-only reads, worker-only mutations, and deletion/tombstone restoration. Three immutable synthetic portfolio orphans are recorded in `provisioned.json`; no portfolio head has been published.

The backend source uses the MakoDB worker session and atomic portfolio head exclusively. The currently running legacy SQLite process has not been stopped. Startup with the protected worker session reaches MakoDB and refuses the missing portfolio head, without falling back to SQLite. Application passwords and renewable worker state are stored only under ignored private directories.

The frozen **rehearsal** copy contains 11 accounts, 146 tickers, 7,808 transactions, 671 value snapshots, 91 splits, 38,131 historical prices, 77 latest prices, 112,653 provider log entries, 25 split-fetch markers, 11 brokerage mappings, and no stored brokerage users. It produces 199 public partitions/manifests, 10 private documents, and one initial command. All **151,096** staged documents and the head validate against their target schemas. This is not the final cutover snapshot: legacy writers remain active.

Source SQL and repository calculations agree for open/all positions, realized P&L, summary, daily performance, money-years, transaction cost sums, historical book values, and trailing-year snapshots. The legacy SQLite `HAVING quantity` resolves to the bare input column, retaining two net-zero open groups; the shared core preserves this behavior and has a regression fixture. Native Rust and Wasm agree on enriched positions, P&L, summary, account performance, and yield (absolute tolerance 1e-8 plus relative 1e-12). Wasm now returns JSON-compatible nulls for absent fields.

Validation passed: 75 Rust tests across the workspace, 26 JavaScript gateway/manifest tests, 16 Python inventory/migration tests, frontend lint/build, all three Wasm targets, and OpenSpec validation. The local auth/RxDB/Dexie integration harness passes seven scenarios: missing parts, coalesced renewal, offline reopen, version catch-up with deletion, checkpoint rebuild, revocation clearing, and new authorization scope/concurrent sign-out. Closing the local store drains an in-flight leader election before closing its channel. A private dirty-cache journal repairs latest prices after interrupted history writes.

The unchanged full-data rollback copy reconciles with the rehearsal export. Python fixtures also verify a simulated post-write rollback, separate credential transfer, exclusive outputs, and checksum failure. Hosted post-write rollback and real browser smoke tests are still required.

### Remaining hosted blockers

- Empty export job `djob_160462a2b59f420c9d5c0db18deb29a8` for `portfolio_heads` remains queued with no progress.
- One-record synthetic import `djob_7e30f2814d453b20965ad06497252330` in `qualification_large_parts` passed upload and dry run (1 row, 94 bytes, zero failures), was confirmed, and also remains queued.
- The CLI explorer route returned HTTP 404 `route not found`, so it cannot substitute for complete destination export/preflight.
- Chrome paused UI automation because another extension UI was open. The source now contains the authenticated frontend, but its real-browser smoke test is incomplete.

Bulk job execution, complete no-write destination preflight, resumable hosted import qualification, final writer freeze/reconciliation, cutover, and a post-cutover write/restart test remain outstanding. **Implementation/rehearsal progress is not cutover approval.**

### Upstream bulk-job fix — September 24

Opened [mako-cloud PR #2](https://github.com/makodb/mako-cloud/pull/2), commit `22a1b8b1de563514563b8de0d002f435a7b755e7`, after reproducing a worker-discovery defect on current upstream main. The global scan used an exact parent system domain, which excludes the tenant-specific domains containing job records. Additional regressions reproduced starvation behind inactive records, the fixed 1,000-key scan, and repeated cancellation of already-terminal jobs.

The PR preserves existing storage keys, adds bounded scanning with continuation/wraparound, and covers empty-export execution through a local RPC stub and artifact store. Local validation passed: 179 control-plane tests, 83 storage tests (complete serial run), scoped Clippy with warnings denied, formatting, and documentation validation. The first parallel storage run hit an existing free-space measurement race; the unchanged complete serial rerun passed. GitHub CI was queued when the PR was opened.

This is a reproduced upstream defect consistent with the hosted symptoms, not a successful hosted migration. Merge/deployment and a fresh hosted import/export check remain required. No real portfolio data was uploaded or cut over during this investigation.


### Resume after worker deployment — September 25 UTC

The user confirmed PR #2 was merged and deployed. Both original queued jobs now report `succeeded`: the empty head export has zero rows and a verified one-byte newline artifact; the synthetic import committed its one row. A no-write preflight exported all eight destination collections and found only the three previously approved immutable synthetic orphans, with no live portfolio head or real portfolio records. The rehearsal snapshot remains distinct from the eventual final frozen source.

A further synthetic import of twelve 30 KB documents (`djob_85d9bbbcaeea0fd0a47d9c22075fd410`) passed dry run but failed execution with zero committed rows. Current upstream code groups up to 32 rows without checking the 256 KiB internal RPC limit. [mako-cloud PR #3](https://github.com/makodb/mako-cloud/pull/3), commit `a423213`, fixes serialized byte budgeting and has a regression that failed before the fix; 182 control-plane tests, scoped Clippy, formatting, and docs validation pass locally.

The compatible workaround was verified on the hosted service: two six-record imports (`djob_756c1659cad9a8470534c8eadfd5b0d4`, `djob_9336b8cca7cca8dd2f1709aaf96c7183`) each committed all six rows. A complete export (`djob_27ea70a6044e19069a08febb529c3d9e`) returned 123 synthetic records / 3,902,794 bytes. All twelve new records match the input exactly, with no duplicates and a verified artifact digest. No real portfolio data participated.

RobinLab's migration tool now bounds potentially oversized import files, verifies deterministic part checksums on resume, accepts successful jobs with historical dependency-retry warnings, and handles the empty-export newline. All 19 Python migration/inventory tests pass, including input tampering and resumed jobs with retry warnings. OpenSpec validation passes; progress is 27/34 tasks.

The browser reaches the application sign-in screen, confirming the previous blank startup has cleared. Sign-in automation remains blocked by another Chrome extension UI; the user has been asked to close it. All legacy writers remain running, and the final source freeze, real import, initial head publication, browser smoke tests, hosted rollback, and cutover remain pending.

### Final freeze and browser verification — September 25 UTC

This section supersedes earlier descriptions of a blocked browser, a running
SQLite writer, and an empty destination. A fresh Chrome tab signs in and starts
live replication. The old automation tab had been closed; no extension UI needs
to be dismissed. The isolated browser harness at
`http://127.0.0.1:5174/tests/replication.html` passes all seven scenarios with real
IndexedDB and Chrome Web Locks: incomplete manifests, coalesced renewal, offline
cache reopening, atomic deletion catch-up, checkpoint reset, revocation clearing,
and scope changes/sign-out. This caught and fixed an elector shutdown call that
worked in Node but was absent in Chrome's Web Locks implementation. The same
seven Node scenarios, frontend lint/build, and 20 Python migration tests pass.

The legacy backend and scheduler are stopped. The final protected snapshot is
`.local/mako-migration/final-20260925`; its SQLite SHA-256 is
`cba517fb0bed81cd12a4e4deefdc647919cc2e7b8e51a02c8a52e7e309cb197e`.
It contains 11 accounts, 146 tickers, 7,808 transactions, 682 value snapshots,
91 splits, 38,148 historical prices, 77 latest prices, 113,013 provider logs,
25 split-fetch markers, 11 brokerage mappings, and no stored brokerage users.
Source financial verification, native/Wasm parity, schema validation, and the
pre-write rollback rehearsal pass. The original database, immutable snapshot,
legacy source revision and runnable legacy binary are retained privately.

All 199 public documents, ten private documents, and the initial command are
staged and match complete cloud exports. A historical-price job failed after
1,920 committed rows with only generic dependency diagnostics. A fresh export
confirmed exactly those 1,920 rows, without collisions or mismatches. A separate
512-row recovery job succeeded. `scripts/mako_stage_recover.py` continues with
bounded create-only imports, retains every failed job receipt, and requires a
fresh exact export comparison before selecting missing rows after a failure.
It never publishes a portfolio head. Progress and receipts are private artifacts.

**Cutover is incomplete.** No portfolio head is published; both backend writers
remain stopped while cache collections import. Remaining work includes complete
staging verification, publication, live API/UI smoke tests, accepted-write rollback,
restart/replication verification, and resuming exactly one scheduler.

Further recovery reached 3,936 historical rows, each confirmed by a fresh exact
export. The cloud also intermittently fails exports before producing any artifact.
[Mako Cloud PR #4](https://github.com/makodb/mako-cloud/pull/4) adds closed failure
categories so these errors can be diagnosed without leaking remote messages or
private document data. Local control-plane tests and scoped Clippy pass. GitHub
Actions cannot start because the upstream account's billing/spending limit blocks
runners; this is not a patch test failure. The recovery tool retries terminal
export failures with fresh jobs and never overlaps an active export.

### Current stop point — bulk worker diagnosis required

Recovery stopped after three consecutive fresh historical-price export jobs
failed before producing an artifact (`djob_02614e9d9c2246ef4f03adf00294e12e`,
`djob_7a8eeaab9c43b3469df93be76154e304`,
`djob_0f0a6aedad2fa04bfb3c76c2ef33448d`). All imports and exports are terminal;
no migration process or temporary developer-password file remains. The last
512-row import committed 480 rows before failing.

Normal worker authentication, the repository head read, and indexed cache reads
still succeed. A complete nine-page indexed query, with all writers stopped,
reconciled **4,416 / 38,148 historical-price rows**, each exactly matching the
sealed package, with no duplicate IDs. The protected artifacts
`gateway-reconciliation.json`, `gateway-historical-reconciled.jsonl`, and
`blocked-bulk-jobs.json` record this stop point. This read does not substitute for
final complete staging verification. Latest prices, provider logs, and split
markers still await import.

PR #4 must be deployed (or equivalent operator diagnostics provided) to identify
the remaining bulk-path error. Neither the source nor the incomplete destination
is exposed as a live writable portfolio. Vite remains on port 5173; backend port
3000 and the legacy scheduler remain stopped. Resume the reviewed recovery tool
against the same sealed final snapshot after the worker issue is resolved, then
finish the unchecked publication, smoke, rollback and restart tasks.

### Resume after reported fix — September 25 UTC

A fresh bulk export succeeded and matched all 4,416 previously staged historical
prices. The bounded import resumed from that exact set, with successful recovery
batches progressing beyond the prior stop point. Source writers remain stopped.
An idle-sleep assertion is scoped to the recovery process and ends when it exits.
PR #4 still appears open; its CI rerun is still blocked before execution by the
upstream account billing/spending limit. These CI failures do not block the
verified local migration checks or successful hosted import batches.

The live API smoke runner now handles the paginated transaction response,
journals synthetic rows for cleanup, and includes Excel replay/occurrence-count
checks plus a non-writing SnapTrade preview and cache-admin validation/prefetch.
Those live checks remain pending initial head publication; preparing the runner
is not a passing smoke result.

During the resume, a separate upstream create-only replay defect was reproduced:
a row committed before batch progress was persisted becomes `already_exists` on
retry. [Mako Cloud PR #5](https://github.com/makodb/mako-cloud/pull/5), commit
`c4a1b5b`, routes create-only writes through the document engine's receipt-first
path. The regression failed on main, passes with the fix, and confirms unrelated
jobs cannot overwrite or treat existing rows as their own commits. All 28
data-plane service tests and scoped Clippy pass. This fix is independent of the
bulk dependency diagnosis; RobinLab continues to reconcile exact exported rows
before retrying a terminal job.

The operator clarified that the bulk worker itself is fixed. Resumed import
batches continue succeeding; the unrelated GitHub Actions billing restriction
does not prevent migration progress.

[Mako Cloud PR #6](https://github.com/makodb/mako-cloud/pull/6), commit `5a8ccac`,
fixes another reproduced export failure mode: abandoned snapshot handles otherwise
occupy all 32 registry slots indefinitely. It expires idle handles after five
minutes, refreshes active leases, and reclaims a job's previous handle when that
same job restarts. The regression exercises capacity, restart, stale cursors,
active leases, and snapshot consistency. All 28 data-plane service tests and
scoped Clippy pass. This resource leak is not established as the sole cause of
the earlier hosted failures, and the healthy migration continues independently.

### Price staging verified after recovery

A later 512-row history job failed after committing 448 rows. A fresh exact
export verified 19,744 historical rows, and recovery imported only the remaining
18,404. The final fresh export now matches **all 38,148 historical-price rows**.
All **77 latest-price rows** were also imported and export-verified. No head is
published; provider-request history and split markers remain in staging.
The generic terminal marker still lacks the diagnostics proposed in PR #4.

Provider-history staging then reached 42,496 successful rows before four
consecutive jobs ended with generic dependency failures after partial progress.
Fresh exports reconciled 42,976, 43,104, 43,360, and finally **43,488 exact rows**.
The exported counts include writes committed before a batch response was lost;
they are authoritative over the worker's lower progress counters. A bounded
five-minute submission cooldown was scheduled, with automatic local resume.
Deployment of PR #4 was requested to distinguish the remaining hosted failure
category. The head remains unpublished, and no original record is overwritten.

The idle browser replica reported a cloud rate limit during this cooldown and
was closed to remove its sync traffic. Project quota and health queries returned
no samples for the preceding hour; this does not rule out throttling or establish
the cause of the bulk failures. Suspending the local wrapper allowed its command
timeout to elapse after a successful dry run; the saved job remained unconfirmed.
Recovery now handles saved uploads/unconfirmed jobs without allocating a second
job, still refuses active writers, and backs off between commands after terminal
failures. All 21 Python tests pass, including unconfirmed-job resume and active-job
refusal. CLI authentication was renewed, and recovery restarted against the same
sealed package with the browser replica closed. Temporary credentials from the
stopped process were removed by its cleanup handler.

### 2026-09-25 — reproduced upstream write contention, awaiting deployment

Further terminal bulk failures and bounded create-only gateway probes brought the
fresh exact provider-history count to **43,925 / 113,013**; **69,088 remain**.
All **38,148 historical prices**, **77 latest prices**, and **210 immutable
portfolio/private/command documents** were previously verified. The 25 split
fetch markers still await import. No importer is running, all journaled bulk
jobs are terminal, and temporary developer-password files were removed. The
legacy backend/scheduler remain stopped; Vite is available on port 5173. No
portfolio head has been published.

Repository gateway version 7 is healthy and active, with unchanged permissions
and resource limits. It exposes only allowlisted upstream status/code/reason
fields; a regression verifies arbitrary error text is withheld. Replaying four
already verified provider-history records in each of four concurrent batches
returned HTTP 503 with `document sequencer is unavailable` every time. Four
serial replays succeeded, and exact point reads before/after verified the source
bodies remained unchanged. Protected evidence is in
`final-20260925/gateway-replay-diagnostics.json`; the full preceding reconciliation
is in `gateway-cache-verification.json`. The bounded batch fallback is not a
qualified throughput solution until the upstream issue is fixed.

The real RocksDB storage adapter returned transient `transaction_commit` errors
when optimistic transactions lost a race after checking their conditions. A
16-thread regression reproduced this before the fix. [Mako Cloud PR #7](https://github.com/makodb/mako-cloud/pull/7)
retries definite Busy/TryAgain commit conflicts in fresh bounded transactions,
rechecking all conditions without retrying ambiguous I/O failures. The regression
now returns one winner and 15 logical conflicts with atomic 128-key results. A
second real-RocksDB test verifies eight concurrent sequencers allocate/finalize
256 unique contiguous positions. Both storage/document test suites and strict
Clippy passed. This reproduces the contention path locally; it does not establish
that every generic bulk failure has the same cause. Deployment of PR #7 and the
safe job diagnostics in PR #4 was requested before further migration retries.
RobinLab's 33 gateway/staging tests and frontend lint pass.
GitHub Actions for PR #7 did not start: the check annotation reports failed
account payments or a spending-limit restriction. Hosted CI is therefore still
blocked by billing; the validation results above were obtained locally.

### 2026-09-25 — deployment confirmed and recovery resumed

The operator confirmed deployment. PR #7 is merged; PR #4 still appears open.
All four hosted concurrent replay batches now return HTTP 200, compared with
four sequencer failures before deployment; exact before/after point reads match.
The evidence is in `gateway-replay-after-deploy.json`.

Fresh bulk exports again verified the 210 immutable portfolio documents, 38,148
historical prices, 77 latest prices, and the prior 43,925 provider records. Six
512-row provider-history jobs then completed without errors (3,072 additional
rows). Each job took roughly a minute. Bulk submissions were stopped and the
last submitted job was allowed to reach success before starting gateway staging.
A 16-row gateway probe completed its write phase in two seconds with only HTTP
200 responses; a full indexed read verified 47,013 exact provider records.

Gateway recovery continues with sealed-source validation, exact fresh indexed
reconciliation, create-only writes and stable mutation IDs. A graceful stop of
the initial run settled in-flight operations and removed its lock before restart.
The staging utility now accepts `--concurrency 1..4` (default 2), bounded by the
hosted function's four concurrent invocations. This run uses batches of 16 and
concurrency 4. No bulk importer runs alongside it. Frontend lint passes. No head
is published; final full verification, cutover and live smoke tests remain pending.

### 2026-09-25 — full staging independently verified

Gateway staging committed the remaining 65,168 provider records in about 90
minutes. The subsequent readback encountered six network failures and one HTTP
403; staging stopped without publishing. A fresh worker session immediately
passed head/query checks. A fresh complete run then verified all 113,013 provider
records, imported all 25 split-fetch markers, and verified both collections
exactly. Its 484 requests all returned HTTP 200. The interrupted report and last
write checkpoint are retained under `*-before-readback-resume.json`.

Independent official-CLI exports now verify **all 151,473 sealed documents**:
199 public, 10 private, 1 command, 38,148 historical prices, 77 latest prices,
113,013 provider records, and 25 split-fetch markers. The large provider export
outlived two CLI wait windows; the same saved job subsequently succeeded with
no errors. `verified-staging.json` is complete with zero missing records in every
collection and confirms no head was published during staging. Source/package
hashes still match the frozen snapshot. Initial publication and live cutover
checks are now proceeding.

### 2026-09-25 — published API and rollback checks

Initial publication succeeded and its committed export matched the frozen source,
including all public/private roots and financial checks. Live owner API reads,
unauthorized-request rejection, all four option actions, transaction creation and
update, and Excel import passed. Excel replay returned the original result and a
new command correctly recognized both identical source occurrences. SnapTrade
preview used the available personal credentials without advancing the portfolio
head. Cache administration validation and cached-price prefetch also passed with
external price providers disabled.

The live reads exposed a RobinLab transport bug: a successful `cache_read` with
JSON `null` was treated as unavailable instead of a cache miss. It is now accepted
only for read/cache-read operations; malformed responses and null mutation results
still fail. The transport regression and all 58 backend tests pass; the backend
was rebuilt and restarted. A repeated accepted command retained its original
result after restart.

The protected API journal tracks 13 reversible synthetic transactions. A
quiescent post-write export rebuilt an isolated SQLite database containing every
one of those writes, matched the exported inventory, and served the updated trade
through the retained legacy binary on a separate port. The isolated legacy
process was then stopped and its checkpointed database verified again. The
original SQLite source remains unchanged.

Live auth/RxDB replication against the real cloud now matches every public table
and all 38,148 historical / 77 latest price rows exactly. Offline reopen and
reconnect preserve that verified view. The initial in-memory IndexedDB run
exceeded ten minutes while scanning the full price collection; its CPU profile
identified fake-indexeddb cursor iteration and it also observed cloud rate limits.
Price materialization now uses bounded 500-row reads and the historical pull batch
is 500 (within the SDK's supported maximum of 1,000). The fresh full-data run
completed initial sync, offline reopen and reconnect before its first 30-second
progress interval. The existing seven local replication checks, lint and build
pass. This library test does not replace the final live-browser visual checks,
which remain blocked by Chrome reporting another extension UI open.

The cleanup phase removed exactly the 13 journaled transactions. The same live
client observed the successive publications through version 26 and then matched
the original five public tables plus both price collections exactly. Sign-out
completed and cleared the protected view. `live-replication-report.json` records
all six live checks as complete; the run's progress reported 100 HTTP requests
and zero rate-limit responses. With all writers stopped, the post-cleanup export
completed every cache collection and passed exact source inventory comparison,
public/private-root validation and financial comparison. The evidence is
`final-clean-cloud-export.json`, `final-clean-comparison.json`, and
`final-clean-cloud-export.financial-verification.json`. The frozen SQLite snapshot
still has SHA-256 `cba517fb0bed81cd12a4e4deefdc647919cc2e7b8e51a02c8a52e7e309cb197e`.

The MakoDB API is restarted on port 3000 and Vite remains on 5173. The API uses
normal configured market-data providers; `SNAPTRADE_SYNC_INTERVAL_MINUTES=0`
keeps its sole automatic importer paused pending the final real-browser visual
checks. No legacy writer or bulk importer is running. Do not rerun initial
publication or staging recovery against the now-live portfolio head. Resume the
single MakoDB scheduler after completing those checks; never restart the legacy
writer against the original source database.

### 2026-09-26 UTC — final Chrome checks and cutover

Chrome access recovered without a visible popup needing dismissal. A fresh owner
sign-in reached the complete cloud portfolio at version 26. Dashboard,
Performance, Transactions, Positions, Import, Brokers and Admin all rendered;
transaction symbol filtering worked and Admin reported 38,148 price-cache rows
for 77 symbols. Reload retained the authenticated, readable version 26 view.
The final tab had no captured console errors.

The Brokers screen exposed a timestamp display issue: an already-zoned migrated
timestamp received a second `Z`, producing `Invalid Date`. The frontend now
preserves explicit timezones, treats legacy unzoned timestamps as UTC, and omits
invalid dates. The real screen now displays the correct last-sync timestamp.
Frontend lint and production build pass; the existing bundle-size warning remains.

All seven isolated Chrome replication checks were rerun successfully with the
final code, including simulated offline reopen, checkpoint recovery, deletion
catch-up, revocation and sign-out. These synthetic browser checks complement the
six exact-data live-cloud auth/RxDB checks; they do not claim that Chrome's network
connection itself was disabled against the live account. Protected screenshots
are `browser-dashboard.png` and `browser-replication-final.png` in the frozen run
directory. The temporary fixture tab and port-5174 server have been closed.

After these readiness checks, the sole MakoDB API was restarted with
`SNAPTRADE_SYNC_INTERVAL_MINUTES=60`. No scheduled command was pending, so the
first automatic import waits one interval. Vite stays on port 5173; the legacy
writer remains stopped. The protected cutover report records the final startup
check. All migration tasks are complete; initial staging/publication must not be
rerun. Future rollback requires a new quiescent export so accepted cloud writes
are retained, as documented in the runbook.
