## Why

RobinLab's data is in MakoDB, but its Axum API and hourly SnapTrade importer still depend on a Rust process running on this laptop. Move that remaining backend into Mako Cloud functions so authenticated writes, imports, provider access and scheduled maintenance work when the laptop is asleep or the local API is stopped.

## What Changes

- Replace the always-running Rust HTTP service with an authenticated `robinlab-api` function in Rational's existing isolated `robinlab` environment.
- Reuse Rust financial and mutation rules through a Wasm-compatible domain boundary; use TypeScript for HTTP, authentication, Mako document access and external-provider transport.
- Preserve the live portfolio's manifest format, conditional head publication, operation identities, replay results, numeric identifiers and RxDB replication contract. This is a compute migration, with no reimport of the portfolio.
- Move local journals, in-memory locks, provider throttling and long-running work to durable, bounded cloud jobs with conditional leases, retry state and a Mako scheduled function.
- Transfer required backend credentials into narrowly scoped function secrets and declare provider HTTPS hosts. Keep owner-only access and private-data isolation.
- Preserve Excel import, SnapTrade preview/apply, option actions, market-data and admin behavior. **BREAKING API behavior for long work:** job admission can return `202` and a job identity; the updated frontend shows progress and preserves the final business result, publishing a portfolio change only when its complete result is ready.
- **BREAKING deployment change:** the frontend calls the deployed function endpoint instead of a local `/api` proxy. Normal operation no longer needs port 3000, a local worker session or a laptop timer. The Vite frontend may continue running locally.
- Qualify real hosted Wasm/bundle limits, external egress, scheduling, CORS and representative full-portfolio execution before switching traffic; stop the old API and its scheduler only after validation.

## Capabilities

### New Capabilities

- `serverless-api`: Owner-authenticated function API with compatible financial behavior, publication/replay semantics, imports and provider access.
- `serverless-jobs`: Durable bounded jobs, scheduled continuation, distributed coordination and secret-safe operations without a local process.
- `serverless-cutover`: Frontend function routing, hosted qualification, compute-only cutover, rollback and verification with the local API stopped.

### Modified Capabilities

None. No main specifications are currently materialized under `openspec/specs/`; the completed `migrate-robinlab-to-makodb` change supplies the existing storage and replication baseline, which this change preserves.

## Impact

- `src/api/cloud*.rs`, pure parts of `src/services/repository_*.rs`, repository format/types, shared Rust/Wasm crates, and existing parity fixtures.
- New function entrypoints and shared modules under `mako/functions/`, plus function configuration, schemas/policies/indexes for private jobs, deployment tooling and hosted checks.
- `frontend/src/api/http.ts`, client types, import/SnapTrade/admin progress views, Vite configuration and environment setup.
- Mako function deployments, secrets, egress rules and schedules in the existing application environment. No changes to unrelated Rational data or actual brokerage trading.
- Runtime/runbook/AGENTS/OpenSpec context documentation; the Rust binary remains available for explicit migration, verification and rollback tooling rather than normal application serving.
