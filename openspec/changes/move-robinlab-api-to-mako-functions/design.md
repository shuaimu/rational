## Context

See `proposal.md` for the motivation. The completed storage migration left a real Axum process on port 3000, a Vite proxy, a protected local worker session, filesystem journals and a Tokio hourly timer. The deployed `repository` function currently authorizes that worker and provides storage primitives; it does not implement the user-facing API. Most frontend financial reads already use authenticated RxDB and Rust Wasm.

The current hosted dataset has 7,808 transactions, 38,148 historical prices and 113,013 provider-history records. Cold-start loading, manifest traversal and large imports therefore need measurement against real invocation limits; warm process caches cannot be correctness requirements.

Platform source reviewed at `makodb/mako-cloud` commit `368fc4e` on 2026-09-26:

- `openspec/specs/functions/edge-runtime/spec.md`: TypeScript/JavaScript Fetch handlers, supported npm/Wasm, declared HTTPS egress and bounded invocation lifetimes.
- `crates/mako-control-plane/src/function.rs`: configurable positive CPU/wall/memory/body/concurrency limits and at most eight declared external DNS hosts per function. Positive-value validation does not establish the deployed service's practical limits.
- `packages/cli/src/commands/functions-deploy.ts`: source bundling and deployment; maximum 512 files and 10 MiB per source file. Actual Wasm packaging must be qualified.
- `openspec/specs/functions/scheduled-functions/spec.md` and schedule HTTP implementation: cron, run history and overlap control. Examples use a separate run credential; the trust boundary must be proven against the deployed gateway, not inferred from an incoming header name.

These establish a supported direction, not proof that every capability is deployed at cloud-test. Qualification is the first implementation gate. The old planning context mentioning SQLite/Supabase is historical; current Mako data remains authoritative.

## Goals / Non-Goals

**Goals:** Eliminate the running local API and laptop scheduler; preserve financial behavior, command replay and public/private data boundaries; complete scheduled work without a browser; retain safe compute rollback against the current Mako dataset.

**Non-Goals:** Reimport data, replace Mako/RxDB, redesign portfolio accounting, host the frontend on a new provider, introduce a permanent external worker, execute brokerage trades, or alter unrelated Rational environments. The development frontend can remain a Vite process.

## Decisions

### 1. Separate the owner API from the scheduled worker

Deploy `robinlab-api` with JWT verification and explicit owner/project/environment checks using the supported function SDK. It serves existing route families: accounts/tickers, transaction CRUD and option actions, import, SnapTrade registration/connect/accounts/link/status, prices/positions/analytics and cache administration. Compile a route/payload/error matrix from the current router before porting. An inventory route cannot be silently omitted because the current frontend happens not to call it.

Deploy a separate `robinlab-jobs` function for scheduled admission and bounded continuation. Scheduled requests need an independently qualified trust boundary. Prefer scheduler provenance only after proving the public gateway strips spoofed metadata; otherwise use a narrowly scoped run credential only with verified protected storage/redaction. Never accept a caller-supplied schedule ID as authorization by itself. Owner job submission/status/cancellation stays behind the API's JWT/owner checks.

Keep the existing low-level repository endpoint worker-only during transition. New functions use shared storage modules and least-privilege service credentials directly; they do not carry or renew the laptop's application-worker password. Retire the old worker path/credential after the rollback window. Alternative: expose the existing generic gateway to the owner. Rejected because storage primitives are not validated domain operations.

### 2. Rust remains the source of financial and mutation semantics

Extract host-independent repository models, mutation planning, normalized ingest, SnapTrade planning and canonical manifest/command encoding into a Wasm-compatible domain crate, using `robinlab-core` for existing calculations. Keep Axum/SQLx/Tokio/Reqwest/PyO3 and filesystem access outside that boundary. Export a versioned JSON/bytes interface for function use and continue comparing native Rust and Wasm on identical fixtures.

TypeScript handles Request/Response, SDK calls, provider HTTP, paging, retries and secret access. Do not independently reimplement financial arithmetic or canonical number serialization in JavaScript. Use deterministic supplied times and stable operation identifiers. Qualify Wasm loading in the deployed bundle, including cold starts and memory; use the bundler's supported asset mechanism or an embedded byte module within its limits.

Separate the existing pure Calamine workbook parser from its SQL adapter and expose it to the server Wasm boundary where qualification permits. Preserve workbook column aliases, dates and occurrence counts. Uploads above a single invocation's body budget use authenticated, sequenced, checksum-bound chunks with a sealed final manifest; unsealed uploads are never importable. Retain the current 50 MiB accepted-workbook ceiling through bounded upload/reassembly and explicit expanded-content limits, rather than silently lowering it. Excel parsing performance and decompression limits must pass qualification before cutover.

Alternative: rewrite all domain logic and XLSX handling in JavaScript. Rejected as the default because it expands the financial parity surface. Failure of hosted Wasm or workbook qualification requires a documented design revision or platform fix before dependent work proceeds.

### 3. Preserve the current one-head storage protocol

Read a pinned head, validate referenced immutable documents, prepare the operation using the shared Rust domain layer, stage changed content and conditionally publish one head. Preserve format versions, hash bytes, ID counters, public/private projections and original command results. Bounded concurrent reads/staging improve cold-start latency without weakening checks. Public replication continues unchanged.

Cold invocations must look up durable command replay, including commands originally accepted by the Rust service. Conflicting heads are replanned from the same immutable captured external input. Publication after a lost response returns the recorded result/version. No correctness depends on an isolate cache, mutex or affinity. Do not change the portfolio layout just to make one function benchmark faster.

### 4. Explicit cloud jobs replace local background work

Use private indexed `robinlab_jobs`, input/chunk and coordination records, accessible to scoped function credentials and exposed to the owner only through redacted API views. Store operation identity, owner/environment, input digest, captured timestamp, state, bounded cursors, attempts, next eligible time, lease generation/expiry, output digest, error code and committed version. Candidate states: uploading, queued, running, retry-wait, succeeded, failed, cancelled and needs-attention.

Acquire and renew leases using conditional revisions and monotonically increasing generations. Checkpoint/transition updates require the current lease generation; an expired worker cannot overwrite later progress. Leases coordinate work, but financial exactly-once behavior rests on the existing stable command identity and conditional head publication. Retries must reuse sealed external inputs; competing workers cannot publish different payloads under the same identity. Never rely on a non-atomic lease check followed by an otherwise unprotected write.

Each invocation processes bounded pages and returns before its deadline. Persist continuation and retry-after times instead of sleeping, spawning background promises or self-invoking without a bound. One short recurring Mako schedule dispatches due work and admits the hourly SnapTrade job using a unique UTC-hour identity. Repeated/overlapping ticks cannot duplicate an hourly import, and unfinished jobs continue even with no browser. Manual and scheduled imports share the same durable coordination.

`202` admission returns a job ID/status location. Completed direct commands retain existing response payloads and `x-robinlab-version`. Completed jobs expose the same domain result plus committed version; the frontend then waits for RxDB catch-up before showing success. Reload finds the same job through the saved command identity. Preview does not publish a head. Cancellation prevents future uncommitted work; if the operation already committed, report the committed outcome instead of claiming cancellation undid it.

External non-idempotent requests, particularly registration, require provider-supported identities or reconciliation. An ambiguous outcome without safe lookup enters needs-attention instead of blindly repeating an irreversible external call. No promise of universal exactly-once remote side effects is made.

### 5. Secrets, egress and provider throttling are cloud-owned

Attach only required service/provider secrets to each deployment. Retain existing private brokerage-user secrets in the private branch; move environment-level credentials to function secrets without logging values. Keep credentials out of job status, source bundles, browser storage and schedule history. Audit response/log redaction in failure cases.

Initial external hosts come from actual code: `api.snaptrade.com`, `api.twelvedata.com` and `financialmodelingprep.com`; qualify redirect behavior and enabled-provider calls against the host allowlist. Yahoo/PyO3 cannot run as a native Python dependency in this runtime. Preserve disabled Yahoo configuration; where Yahoo is enabled, use a qualified HTTPS adapter with parity tests and explicit hosts rather than silently losing functionality. No subprocess or local Python fallback remains in normal operation.

Move per-provider throttles/cooldowns from process memory into conditional shared records so concurrent isolates respect provider limits. Persist retry-after times and record sanitized usage outcomes. Cache mutations retain indexed paging and recovery intent; administrative summaries use bounded work/materialized results when full scans exceed the deadline, with an observable freshness marker rather than incomplete totals.

Cache maintenance uses a durable job lane plus sealed per-document mutation intents. Every intent contains its original expected revision, body, and stable SDK mutation ID; a delayed claimant can only replay that receipt. A public owner-readable `cache_status` record exposes one complete latest-price snapshot and a digest/count of the historical rows. Maintenance publishes an updating marker before row changes and atomically replaces the complete snapshot after all writes. The cloud frontend retains its previous verified price view until both the ready marker and matching historical digest have replicated. Portfolio manifests and their command chain are unchanged. Compute rollback drains cache jobs first and can continue using the fully rebuilt legacy cache collections.

Sealed uploads bind by conditional revision to one job before admission. Seven-day cleanup expires unbound roots before deleting chunks and never removes the root's command tombstone. Terminal job captures are cleaned in bounded pages; completed response artifacts, durable job receipts, portfolio history, active jobs, and needs-attention inputs survive. Registration uses a singleton job and a durable pre-request marker; a lost response is recovered from its private named capture or held for reconciliation without a second registration request.

### 6. Route frontend requests directly to functions

Configure the public API function base URL from the selected Mako environment, preserving logical API paths in the client. Remove the localhost:3000 Vite proxy dependency and implicit fallbacks. Keep JWT renewal, durable Idempotency-Key values, response-version handling, offline local reads and protected-state clearing. Qualify OPTIONS, allowed origins, authorization/idempotency headers and exposed version headers on the real gateway.

The user-requested architecture supersedes the old repository convention that all API traffic must use a local Vite proxy. Update that convention and stale runtime context during implementation. No frontend hosting change is required.

## Risks / Trade-offs

- **Cold head traversal and full-history work exceed function limits** → Measure the current full dataset cold, bound SDK concurrency, move long work into jobs and refuse cutover if any indivisible domain computation cannot fit a qualified limit.
- **Wasm packaging or Excel parsing differs in the hosted runtime** → Qualify early with a native/Wasm parity fixture and representative/maximum-size workbooks; retain the old service until the gate passes.
- **Scheduled invocation metadata can be spoofed or credentials exposed** → Test the public endpoint and management surfaces; use only a proven authorization path. File a focused upstream PR for a reproduced platform gap, using the user's standing authorization.
- **Two schedulers or an old in-flight process race during cutover** → Pause admission, drain/record in-flight operations, stop the local timer, then enable exactly one cloud schedule. Keep idempotent job admission and publication as the second line of protection.
- **Long operations gain asynchronous UI behavior** → Preserve final business results, stable replay, clear job progress and version catch-up; do not label an accepted job as completed.
- **Provider calls incur cost or change source data during qualification** → Use read-only preview and isolated synthetic writes, provider-off replay where possible, and explicit cleanup journals. Real scheduled imports begin only after final cutover.

## Migration Plan

1. Inventory routes, dependencies, secrets by name, local journals, in-flight timer state and immutable format/parity fixtures. Keep the current service live during development.
2. Qualify hosted Wasm, workbook limits, egress, CORS, function lifecycle, scheduling authorization and full-dataset budgets using isolated fixtures. Record actual versions/configuration; source capability alone is insufficient.
3. Implement shared domain extraction, function repository/auth adapters and the route matrix. Add private job/coordination schemas and deploy API/worker versions with scheduling disabled.
4. Verify hosted parity, concurrent edits, retries, import occurrence counts, provider failures, cold restart and interrupted jobs. Test an isolated frontend against cloud functions while the normal app remains on its current backend.
5. Pause the old scheduler, drain all writers, capture a fresh quiescent cloud export and retain the current Rust binary/configuration. Stop old API admission, switch the frontend and verify a reversible write, replay, UI catch-up, import and reload with no port-3000 listener.
6. Enable one cloud dispatcher schedule. Prove a hosted scheduled tick and resumable work with local API/tests stopped, remove temporary fixtures, confirm no double importer, and record operational/rollback instructions.
7. Roll back compute by pausing cloud admission and schedules, reconciling all in-flight jobs/commands, then restoring the previous API/frontend routing against the **current MakoDB state**. Never restore a pre-cutover portfolio snapshot over accepted writes. The existing SQLite disaster-recovery process remains a separate explicit operation.
