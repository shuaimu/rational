## 1. Qualify hosted integration

- [x] 1.1 Obtain the official MakoDB RxDB adapter and authoritative HTTP contract, record source/version/integrity, and verify installation with the existing RxDB/RxJS versions; report unavailable artifacts without substituting guessed interfaces.
- [x] 1.2 Resolve Rational project metadata and availability of an isolated `robinlab` environment; inventory only metadata and refuse collisions with existing application data.
- [x] 1.3 Define synthetic qualification schemas/policies and provision the isolated environment, owner/worker identities, exact service scopes, keys, and development origins using supported flows.
- [x] 1.4 Deploy a minimal worker-authenticated gateway and demonstrate allowed worker calls, denied owner/foreign-user privileged calls, session renewal, and pause on revocation.
- [x] 1.5 Prove conditional single-head publication with staged partitions, concurrent writers, failed staging, and lost responses; measure document/function limits and representative dataset costs. Record go/no-go findings before dependent implementation.

## 2. Model persistent data and domain boundaries

- [x] 2.1 Inventory runtime tables and SQL read/write sites; map every table and compound key to public/private cloud schema, access policy, index, and retention behavior.
- [x] 2.2 Define typed repository datasets, mutation inputs/results, canonical serialization, numeric ID bounds, manifest/partition formats, and stable operation identities.
- [x] 2.3 Extract account/ticker/transaction reads and pure mutation preparation from SQL handlers while preserving existing API payloads and domain validation.
- [x] 2.4 Adapt portfolio/analytics/split calculations to repository datasets; add financial parity fixtures using identical prices, dates, and explicit numerical tolerances.

## 3. Implement authoritative cloud storage

- [x] 3.1 Implement bounded repository gateway reads/staging/commit routes, worker principal checks, distinct per-call request IDs, retry mapping, and credential redaction.
- [x] 3.2 Implement immutable partition/manifest writes, public/private branch separation, head pinning, reference validation, and conditional publication.
- [x] 3.3 Implement persistent command replay lookup and conflict recomputation, including business ID allocation, changed-payload rejection, and recovery after a committed response is lost.
- [x] 3.4 Port accounts/tickers/transaction CRUD and option roll/close/expiry/assignment to complete cloud operations; test partial failure and concurrent edits.
- [x] 3.5 Port normalized ingest and Excel import with occurrence-count deduplication, stable retry IDs, and bounded import staging.
- [x] 3.6 Port SnapTrade mappings, secret persistence, balances, snapshots, and watermarks; test restart during scheduled import and expired/revoked worker sessions.
- [x] 3.7 Port historical/latest prices, split-fetch state, and provider usage/cache administration with explicit indexed pagination and no unindexed scan assumptions.
- [x] 3.8 Replace runtime SQLite initialization with validated MakoDB configuration and protected route state; verify startup and operations when legacy data services are inaccessible.

## 4. Implement authenticated local reads

- [x] 4.1 Separate Wasm initialization from Supabase and implement owner sign-in, session persistence/renewal, sign-out, and protected route/view boundaries.
- [x] 4.2 Attach application authentication and durable request identities to protected `/api` calls; validate owner identity and tenant server-side for all routes and admin actions.
- [x] 4.3 Add MakoDB transport collections, scoped database names, checkpoint persistence, and shared live replication; verify foreign identity/environment isolation.
- [x] 4.4 Implement public-manifest completeness checking and generation-based local read models; test out-of-order heads, missing partitions, deletions, and consistent multi-table reads.
- [x] 4.5 Replace full-table post-write refresh with committed-version catch-up; display pending sync until the active local generation includes the write.
- [x] 4.6 Implement offline reload, reconnect, authorization reset, definitive-revocation clearing, schema/checkpoint recovery, and terminal error handling; add meaningful browser integration coverage for these behaviors.
- [x] 4.7 Remove production Supabase polling/dependencies and automatic seed hydration; update local fixture tooling and configuration documentation without committing credentials.

## 5. Build and rehearse migration

- [x] 5.1 Implement authoritative SQLite source inventory covering normalized record hashes, references, trade multiplicity, and private-record classification. Supabase is obsolete by user confirmation and is excluded from reconciliation.
- [x] 5.2 Implement consistent snapshot export and no-write destination preflight/dry run with explicit source/destination identifiers and an immutable reconciliation manifest.
- [x] 5.3 Implement resumable immutable-data import and separate credential transfer; test repeated runs, destination collisions, interruption, checksums, and initial head publication.
- [x] 5.4 Implement verification reports comparing counts, fields, references, positions, P&L, performance, balances, snapshots, and import resume state.
- [x] 5.5 Implement rollback export/replay into a restored legacy dataset and rehearse both pre-write rollback and rollback after accepted cloud mutations.

## 6. Validate and cut over

- [x] 6.1 Run `cargo test`, frontend lint/build, core Wasm compatibility checks, and focused gateway/commit/replication/migration tests; record failures and resolve migration regressions.
- [x] 6.2 Perform staged smoke tests for accounts, transactions, positions, analytics, all option actions, Excel import, SnapTrade with available credentials, cache admin, fresh-browser login, offline reload, and unauthorized requests; retain UI screenshots for review.
- [x] 6.3 Resolve source integrity discrepancies, verify backups and destination readiness, pause all SQLite writers, and capture the final consistent authoritative source manifest.
- [x] 6.4 Execute the verified resumable migration and secret transfer, compare final results, and switch backend persistence and browser replication together only when all readiness checks pass.
- [x] 6.5 Verify a new write and subsequent restart/replication against MakoDB, resume one scheduler, and record cutover and rollback instructions while retaining protected legacy backups.
