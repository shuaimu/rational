## 1. Inventory and qualify hosted execution

- [x] 1.1 Inventory every current route, request/result/error shape, idempotency rule, local journal/lock/timer and enabled provider dependency; record credential names only and retain the current cloud-format/parity baseline.
- [x] 1.2 Pin the authoritative platform/SDK/CLI/runtime versions and qualify hosted Wasm loading, cold start, bundle size, memory/CPU/wall budgets and dependency support using isolated fixtures.
- [x] 1.3 Qualify complete pinned-portfolio traversal and bounded staging at current dataset scale; record request counts and latency with no warm-cache dependency.
- [x] 1.4 Qualify workbook parsing and bounded upload for representative files and the existing 50 MiB ceiling, including expanded-content limits and interrupted/changing chunks.
- [x] 1.5 Qualify real JWT/owner enforcement, browser CORS/version headers, declared provider egress and schedule authorization, including spoofed schedule headers and secret-safe management/history surfaces.
- [x] 1.6 Record the hosted go/no-go report; resolve reproduced platform gaps with focused upstream fixes before dependent cutover work, without stopping the working local API.

## 2. Extract the shared server domain

- [x] 2.1 Move host-independent repository models, command identity and canonical manifest encoding behind a Wasm-compatible boundary; preserve native/wasm byte-for-byte format and hash fixtures.
- [x] 2.2 Extract account/transaction mutation preparation and existing option/analytics adapters without importing host-only dependencies into shared crates.
- [x] 2.3 Extract normalized ingest, workbook parsing and SnapTrade plan preparation, preserving duplicate occurrences, roll/split behavior and supplied time semantics.
- [x] 2.4 Expose a versioned function-facing Wasm interface and reproducible bundle build; run native/Wasm parity tests and verify immutable-format compatibility with the live dataset.

## 3. Implement authenticated function storage and routes

- [x] 3.1 Add the owner API and scheduled-worker entrypoints, bounded configuration and scoped secret/egress manifests; keep scheduled execution disabled during development.
- [x] 3.2 Implement shared SDK repository reads, immutable staging, command lookup and conditional head publication with bounded concurrency and sanitized error mapping.
- [x] 3.3 Test cold-instance replay of pre-cutover commands, concurrent head conflicts, failed staging and committed-but-lost responses; preserve original business results and versions.
- [x] 3.4 Port account/ticker/transaction and all option-action routes with unchanged validation and shared-domain results.
- [x] 3.5 Port portfolio/version, price/position and analytics routes, including routes not currently called by the UI; prove each route against the inventory matrix.

## 4. Replace local journals and timers with cloud jobs

- [x] 4.1 Define/provision private job, input-chunk and coordination collections with bounded indexed queries, service scopes and explicit terminal-artifact retention.
- [x] 4.2 Implement stable job admission, input sealing, authorized status/result access, cancellation semantics and durable retry-after/error states.
- [x] 4.3 Implement conditional leases/generations and checkpointing; prove expired-claimant rejection, duplicate admission, response-loss replay and continuation after worker termination.
- [x] 4.4 Implement the bounded dispatcher, hourly SnapTrade admission and manual/scheduled coordination; prove no dependence on browser activity, a local file, sleeping invocation or unbounded self-invocation.
- [x] 4.5 Implement bounded cleanup of unreferenced terminal upload/job artifacts while preserving active jobs, live portfolio references and durable command history.

## 5. Port external integrations and long operations

- [x] 5.1 Port SnapTrade signing, registration/connect/account discovery/link/status and safe reconciliation of ambiguous registration results using function secrets.
- [x] 5.2 Port SnapTrade preview/apply capture and resumable processing; keep preview head-neutral and publish final transactions/balances/watermarks atomically.
- [x] 5.3 Implement authenticated bounded Excel uploads and import jobs with integrity checks, shared parser semantics, occurrence-count deduplication and replay across reconnect/reload.
- [x] 5.4 Port configured price/split providers to supported HTTPS transport and shared cloud rate limits; remove native Python/subprocess dependencies from normal operation and verify enabled-provider parity.
- [x] 5.5 Port cache clear/prefetch, recovery intent, usage/coverage/trend endpoints and bounded complete-summary computation with explicit freshness where asynchronous.

## 6. Connect and validate the frontend

- [x] 6.1 Replace the local proxy base with the configured cloud function endpoint, retaining owner JWT renewal, durable command identities and response-version catch-up without localhost fallback.
- [x] 6.2 Add visible long-operation progress and durable job recovery to import, SnapTrade and admin flows; distinguish accepted, committed, failed, cancelled and needs-attention outcomes.
- [x] 6.3 Run Rust/domain/Wasm, function/repository/job/integration tests, frontend lint/build and OpenSpec validation; resolve migration regressions and record resource-limit results.
- [x] 6.4 Smoke an isolated browser against hosted functions for all route families, fresh sign-in, replay, local catch-up, offline/reload, auth failure and interrupted jobs; retain protected screenshots and clean synthetic writes.

## 7. Cut over and remove the local runtime dependency

- [x] 7.1 Pause the local scheduler, drain/reconcile pending operations, preserve the current Rust binary/configuration and capture a fresh quiescent Mako export with verified comparison and replay checkpoints.
- [x] 7.2 Activate qualified function versions, switch normal frontend routing and stop the old API; verify read/write/import/replay/catch-up with no port-3000 listener and no temporary worker assisting execution.
- [x] 7.3 Enable exactly one Mako dispatcher schedule; prove a hosted due/run-now tick, hourly deduplication and resumable work with local API and test workers stopped, then reconcile disposable test artifacts.
- [x] 7.4 Update runtime/setup/runbook/AGENTS/OpenSpec context documentation, document compute rollback against current Mako state and credential retirement after the rollback window, and record final process/schedule/deployment evidence.
