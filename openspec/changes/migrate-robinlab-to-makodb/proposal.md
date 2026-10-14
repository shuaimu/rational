## Why

RobinLab writes to SQLite while its browser reads through a local RxDB cache. The user confirmed on 2026-09-24 that Supabase is no longer used and all remaining Supabase integration is obsolete. Migrate the authoritative SQLite dataset and browser replication to MakoDB while retaining local reads and existing portfolio calculations. Supabase access and exports are not migration prerequisites.

## What Changes

- Use the existing Rational project at `https://cloud-test.makodb.com/`, owned by the developer account `msmummy@gmail.com`. Plan a separate `robinlab` environment within that project; verify environment availability before provisioning.
- Replace runtime SQLite persistence with MakoDB document storage, explicit indexes, revision-aware writes, and recoverable, atomically published portfolio operations.
- Replace Supabase polling and seed-based production startup with authenticated MakoDB replication into RxDB/Dexie.
- **BREAKING**: require a RobinLab application session; the existing MakoDB developer-console session does not authorize application data. Protect backend routes and retain single-owner access.
- Preserve Rust domain logic, relative `/api` endpoints, Wasm calculations, brokerage imports, price providers, and existing business identifiers.
- Export, reconcile, dry-run, and migrate existing data, then verify portfolio results before switching the writer. Retain offline backups and a tested rollback path.
- Qualify SDK availability, hosted function connectivity, and document commit semantics before implementing the dependent integration. The documented npm adapter returned 404 during discovery.

## Capabilities

### New Capabilities

- `mako-persistence`: authoritative cloud storage, protected backend access, consistent operations, and integration-state persistence.
- `mako-local-replication`: application authentication, isolated local caches, MakoDB replication, and offline reads.
- `mako-data-migration`: reconciled migration, verification, cutover, and rollback.

### Modified Capabilities

None; this repository has no existing main capability specs.

## Impact

Backend: `src/db`, all SQL-dependent routes/services, startup/configuration, error mapping, scheduled SnapTrade work, and calculation input loading. Frontend: API client, RxDB wiring, Supabase/Wasm module separation, application session boundary, sync state, and seed tooling. New hosted functions and environment configuration are required because hosted privileged document routes are loopback-only. Dependencies change from runtime SQLx/Supabase to MakoDB HTTP/SDK integration; SQLite may remain in migration tooling. Existing Rational environments must remain intact.

## Non-goals

Changing financial formulas, adding multi-user portfolio sharing, rewriting the React UI, removing Rust, enabling arbitrary offline financial writes, deleting legacy databases/cloud projects, or modifying MakoDB itself.
