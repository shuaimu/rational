## Context

See proposal.md for motivation and scope. Backend routes and services hold `Pool<Sqlite>` directly, including joins, integer allocation, and transactions spanning several records. Option actions in `src/api/transactions.rs` and SnapTrade import in `src/api/snaptrade.rs` depend on SQL transactions. `src/services/ingest.rs` deduplicates using occurrence counts, not merely a unique trade hash. The browser uses RxDB 17 and RxJS 7; `afterWrite` currently refreshes full backend tables. Wasm loading is coupled to the Supabase module despite not requiring Supabase.

Discovery on 2026-09-23 verified the console account and Rational project (`prj_43f3756d4588d7412cbe0b633a455695`). The [MakoDB User Book](https://cloud-test.makodb.com/docs/user-book) documents no SQL interface, revision-conditional document mutations, per-row replication outcomes, application identities distinct from developer identities, and privileged `/service/` routes available only on the internal origin used by edge functions. It does not establish atomic multi-document writes. The documented `@mako-cloud/rxdb` package returned npm 404. A focused check found no SDK in the adjacent `mako-followup` directory; the CLI is not on PATH. These are qualification tasks, not capabilities to assume.

The user confirmed on 2026-09-24 that Supabase is obsolete. SQLite is the authoritative migration source; no Supabase availability or export is required. Preserve the existing local browser reads during implementation, and remove obsolete Supabase dependencies and automatic seed hydration.

## Goals / Non-Goals

**Goals:** preserve calculation inputs, business IDs, API behavior, import multiplicity, and complete-operation visibility; converge browser and backend on MakoDB; provide repeatable verification and rollback.

**Non-Goals:** simultaneous independent SQLite/MakoDB writers, client-side financial mutation authority, rewriting provider clients in TypeScript, or changing Rational's existing application environments.

## Decisions

### 1. Isolate RobinLab inside Rational

Use the confirmed existing project. The proposed environment name is `robinlab`; resolve its actual identifier during implementation and record endpoint/project/environment explicitly. Reuse an existing environment of that name only after verifying ownership and contents. An environment quota or naming conflict stops provisioning with a diagnostic; it must not redirect into Rational production. Environment separation avoids schema, identity, policy, and credential collisions more completely than collection prefixes alone. No hosted resources are changed by this proposal.

### 2. Retain Rust as the domain service and introduce repository boundaries

Keep the browser's relative `/api` routes and existing payloads. Replace SQL-dependent service inputs with typed repositories and datasets; perform joins and aggregations in Rust or existing shared calculation code. Extract pure mutation preparation from SQL execution. `crates/core` remains host-independent. Preserve numeric business IDs and relation fields, storing transport keys as strings; allocate new integer IDs through the portfolio commit described below, with safe-integer range checks. Use canonical encoded composite keys for date/symbol and date/account records.

Keep SQLite access only in legacy migration/rollback tooling after cutover, not as an automatic runtime fallback. Alternative: a SQL compatibility connection is unavailable. Keeping SQLite indefinitely with a cloud mirror fails the requested replacement of both layers.

### 3. Use authenticated hosted gateways for trusted persistence

Add small hosted functions for bounded repository read/stage/commit operations. Rust authenticates to these with a dedicated application worker identity, checked against an explicitly configured trusted principal. Function-side service credentials have only the exact RobinLab collection/operation scopes; they never reach Rust clients or browsers. Each internal service call uses a distinct request identifier. Do not put a service key on the public `/service/` URL; the documented proxy refuses it.

The browser signs in as the provisioned RobinLab owner, whose immutable application-user ID is explicitly configured. Matching the developer account's email alone grants nothing. Browser policies allow owner reads and deny direct financial writes. Rust validates the owner session, tenant, and current authorization before every protected `/api` operation, including admin/import/SnapTrade; worker-only gateways reject owner tokens and untrusted users. Provision the worker identity without public self-assignment of trusted claims. Rust's renewable worker session is server-only secret state; unattended jobs use it and pause on definitive revocation. Prove this flow with synthetic data before storing portfolio records.

This retains existing Rust integration code while respecting hosted service-route restrictions. Moving all integration logic to edge functions would add an unnecessary language/runtime migration. Allowing the browser to call a privileged write gateway would bypass domain validation.

### 4. Publish immutable portfolio versions through one conditional head update

Do not treat a successful batch of individual MakoDB mutations as a SQL transaction. Represent the authoritative portfolio as immutable, bounded partitions referenced by a manifest tree and one revision-conditional `portfolio_head` document. The head identifies the complete committed manifest and next integer IDs. A command loads one head, computes its full result, writes changed partitions and manifests with create-only deterministic identities, verifies all referenced content, and conditionally replaces that same head revision. Readers pin one head and see only its referenced versions. Independent price observations and request logs use ordinary revision-aware documents; an operation requiring changes to portfolio records and import watermarks includes both in the committed manifest.

Manifest nodes and partitions are size-bounded, use stable partitioning/content hashes, and reuse unchanged children. The head publishes public and private manifest-root references together: browser synchronization traverses only the owner-readable public branch, while backend reads may traverse both. Private partitions and command payloads remain in separate denied collections; public manifests contain no credential or private integration payload. A root-to-leaf walk uses point reads rather than an unindexed scan. Account/ticker uniqueness and reference integrity are validated against the pinned dataset before publication. On a concurrent-head conflict, reload and recompute rather than overwriting. Allocate IDs only in the winning publication; gaps are acceptable but reuse is not.

Each committed manifest records a command ID, normalized request hash, response, and predecessor. After a lost response or restart, determine whether the command already exists in committed history before retrying. A repeated command with changed inputs is rejected. Unpublished content has no business effect and is excluded from all reads. Retain history for the documented replay/rollback window; introduce garbage collection only after reachability and replay retention are tested. This gives one explicit atomic publication point without assuming multi-document transactions or trying to compensate partial financial writes.

Qualification must prove single-document compare-and-swap, replay behavior, document/function size limits, and acceptable full-dataset and changed-partition costs against the hosted contract. A failed proof blocks dependent implementation/cutover and requires revising this design, not silently weakening atomicity.

### 5. Replicate committed versions and materialize local read models

Use the supported adapter once its package/source is verified and pinned. Replicate owner-readable head/manifests/portfolio partitions and prices with a shared live stream where supported. RxDB transport collections are distinct from local accounts/tickers/transactions read models. A head may arrive before its partitions; wait for and verify the complete referenced tree before exposing that generation. Keep the previous complete generation visible during ordinary sync. Materialize into a new generation and atomically select it for queries; never mix table generations. Backend reads follow the same head pinning rule. The public tree also derives an owner-readable `broker_balances` projection containing only `account_id` and `balance`; private brokerage identifiers and credentials stay in the private tree. This preserves account-performance reads without replicating private connection records. The server verifies the projection against the private branch while loading.

After an API write, wait until the local active generation includes the returned committed version before reporting the view as refreshed. Handle a newer descendant head as satisfying that wait. Remove the current full-table refresh and Supabase poller once parity is proven. Move Wasm loading into an integration-independent module. Scope local database names and replication identifiers to endpoint, project, environment, application user, schema, and security generation so old Supabase data cannot merge into MakoDB.

Ordinary offline startup retains an established owner's cached read view and shows its stale/sync state; financial writes require connectivity. Sign-out, definitive revocation, or an authorization-epoch mismatch blocks protected rendering, stops replication, and clears protected data/checkpoints before another identity/generation starts. Temporary network failure must not be treated as revocation. Handle terminal policy/schema errors and checkpoint expiry explicitly rather than retrying forever.

### 6. Map all persisted domains deliberately

| Existing data | Destination / visibility |
| --- | --- |
| Accounts, tickers, transactions, splits, value snapshots | Committed versioned portfolio data; owner-readable |
| SnapTrade mappings, balances, import watermarks | Private committed partitions; backend-only; sanitized balance data projected for the owner |
| SnapTrade user secrets | Scoped hosted secrets or private credential records; never replicated; migrate by dedicated secret handling |
| Historical/latest prices, split-fetch metadata | Bounded indexed document collections; only required prices/splits readable by owner |
| Provider request log | Backend-only indexed documents with redacted errors |
| SQLite schema migration history | Retained in source archive; replaced by versioned MakoDB provisioning records |

Define schemas and indexes from actual read patterns; qualify paging limits and complete enumeration. Preserve existing floating-point values, dates, nullable fields, transaction provenance, and IDs. No rounding or financial formula changes belong in this migration.

## Risks / Trade-offs

- SDK unavailable → obtain the official registry/source artifact, pin it, and test its RxDB 17 compatibility before dependency changes; do not invent an SDK interface.
- Hosted test-service constraints → validate quotas, function limits, retry semantics, availability, and backups using synthetic data first.
- Manifest protocol complexity and storage growth → test crash/concurrency cases, reuse partitions, measure costs, retain safe history, and defer pruning until verified.
- Source snapshot drift → freeze all SQLite writers before the final export, retain checksums and reference checks, and compare the destination against that frozen snapshot. Obsolete Supabase stores and seed files do not participate in source selection.
- Single head serializes portfolio commits → acceptable initial single-owner trade-off; benchmark representative imports and concurrent price work.
- Authentication changes → explicit owner provisioning and sign-in smoke tests; developer-console access is insufficient.

## Migration Plan

1. Obtain/pin SDK and contract; prove gateway authentication and conditional publication with synthetic documents. Record exact limits and benchmark budgets.
2. Provision the dedicated environment, policies, indexes, owner/worker identities, and gateway functions; exercise access-denial cases.
3. Implement repository/mutation boundaries, committed-version storage, frontend session/replication integration, and migration tools. Run against synthetic and isolated copied fixtures.
4. Inventory the configured SQLite source. Verify counts, normalized row hashes, ID references, duplicated occurrences, financial results, and secret inventories. SQLite is the authoritative business ledger; compare the imported destination with its frozen manifest. Supabase is obsolete by explicit user confirmation and must not block migration or contribute records. Do not treat bundled seed files as authoritative.
5. Pause manual/import/scheduled writers, create consistent read-only source backups, export with checksums, and run a no-write dry run against the isolated destination. After it passes, execute the resumable import. Capture high-watermarks and destination command IDs. Import secrets separately without logs or browser exposure.
6. Verify all records and calculation parity, then publish the initial head and switch both runtime writers and browser source together. Staging may exercise replication first, but production must not end with two authoritative stores. Verify fresh-browser startup, offline reload, mutations, option actions, imports, background sync, analytics, and admin operations.
7. Before any new cloud writes, rollback can restore the frozen source and configuration. After cloud writes, first freeze the MakoDB writer, export/replay all committed deltas into an isolated restored SQLite copy, reconcile, and only then switch back. Never point to an old backup and discard accepted writes. Keep source backups, manifests, and run reports outside version control.

## Open Questions

- Exact official SDK artifact/registry/source location and version (required before the SDK qualification task can finish).
- Assigned `robinlab` environment ID, application-user IDs, and available quota, resolved through provisioning without changing the selected project or isolation model.
- Row counts, partition-size budget, and authoritative reconciliation outcomes, measured during inventory before importing real data.
