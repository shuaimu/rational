# Repository Guidelines

## Project Overview
Rational Investment is a Rust + React stock and option trading tracker that replaces spreadsheet-based portfolio tracking across multiple brokerage accounts. Mako Cloud functions own writes, imports, market-data lookup, SnapTrade integration, and MakoDB persistence. The Rust/Axum backend is retained for migration tools, parity checks and explicit compute rollback. The frontend is local-first for reads, using authenticated MakoDB replication into scoped RxDB/Dexie databases, with shared Rust calculation logic exposed through Wasm.

## Project Structure & Module Organization
Hosted application code lives in `mako/serverless/`: `api/` serves owner-authenticated requests, `jobs/` runs bounded scheduled phases, and `shared/` holds repository, uploads, rate limits and job helpers. Pure server domain logic is in `crates/domain/`, with `crates/function-wasm/` exposing it to functions.

Retained native application code lives in `src/`:
- `src/api/` for Axum routes and HTTP handlers, including accounts, tickers, prices, transactions, positions, analytics, admin, import, and SnapTrade routes
- `src/services/` for domain logic such as portfolio math, Excel ingest, market data, SnapTrade, splits, and option roll/assignment handling
- `src/db/` for the authenticated MakoDB client, immutable portfolio repository, indexed caches, and data models; SQLx helpers remain for migration and parity tests
- `src/main.rs`, `src/config.rs`, and `src/error.rs` for startup, configuration, and shared error handling

Shared Rust crates live in `crates/`:
- `crates/core/` contains pure portfolio/analytics calculations and must remain compatible with `wasm32-unknown-unknown`; do not add SQLx, Tokio, Reqwest, PyO3, or other host-only dependencies there
- `crates/wasm/` exposes `robinlab-core` through `wasm-bindgen`; generated packages are checked into `crates/wasm/pkg*` and `frontend/src/wasm/`

Legacy SQLite migrations in `migrations/` support source verification and rollback. Runtime startup requires an initialized MakoDB head and a protected worker session; it never opens SQLite. Cloud schemas and policies are in `mako/`.

Frontend code is in `frontend/src/`:
- `pages/` for route-level screens such as Dashboard, Performance, Transactions, Positions, Import, Brokers/SnapTrade, and Admin
- `components/` for reusable UI pieces such as layout and position/transaction tables
- `api/` for the Axios client, shared types, Wasm loader, RxDB local store, scoped auth, and replication wiring
- `utils/` for frontend-only calculation/display helpers

The `supabase/` directory contains obsolete historical support files; Supabase is no longer used. Generated/runtime artifacts include `target/`, `frontend/dist/`, `frontend/node_modules/`, `frontend/public/seed/*.json`, `robinlab.db`, backup `robinlab.db.pre-*` files, and dev logs.

## Build, Test, and Development Commands
```bash
# Backend / workspace (repo root)
cargo run                 # explicit rollback/development API only; not normal startup
cargo build --release     # optimized binary
cargo test                # run all Rust tests, including workspace crates
cargo test -p robinlab-core

# Frontend
cd frontend && npm install
cd frontend && npm run dev       # investment assets on 5174; use the Rational proxy on 5173/investment/
cd frontend && npm run build     # type-check + production build
cd frontend && npm run lint      # ESLint
```

## Coding Style & Naming Conventions
Rust: use `rustfmt` defaults, `snake_case` for functions/modules, and `PascalCase` for structs/enums. Keep HTTP concerns in `src/api`, domain logic in `src/services` or `crates/core`, and persistence concerns in `src/db`.

TypeScript/React: use 2-space indentation, semicolons, `PascalCase` component files, and `camelCase` functions/variables. Keep API shape definitions in `frontend/src/api/types.ts`, backend write calls in `frontend/src/api/client.ts`, and local-first replication logic in `frontend/src/api/rxdb.ts`.

When changing portfolio, P&L, performance, split, or option behavior, prefer implementing shared logic in `crates/core` and exposing it through `crates/wasm` when the frontend needs the same result.

## API Surface
Current API routes are served under the configured `robinlab-api` function URL and include:
- accounts, tickers, latest prices, transactions, option roll/close/expire/assign actions, and positions
- Excel import via bounded `/uploads` chunks, sealing, and `/import/excel` job admission
- SnapTrade registration, connection, account linking, status, and import
- analytics summary, performance, yield, accounts performance, and ticker P&L
- admin API usage, cache coverage/trends, cache clear, and prefetch

Frontend API calls use route-relative paths through `frontend/src/api/http.ts`, which targets the configured Mako `robinlab-api` function with owner JWT and durable idempotency keys. There is no Vite API proxy or localhost fallback. The normal development command starts only Vite; no Rust server or local timer is needed. Long operations return durable cloud jobs; retain command identities until the published portfolio/cache generation reaches the local replica.

## OpenSpec Workflow
OpenSpec lives at the Rational root in `../openspec/`, using the `spec-driven` schema. Run OpenSpec commands from that root.

Use `$openspec-propose "change description"` to create a proposal, design, delta specs, and tasks before implementation. Use `$openspec-apply-change <change-name>` to implement an approved change, then `$openspec-archive-change <change-name>` when complete. Validate OpenSpec artifacts with `openspec validate --all`.

## Testing Guidelines
Focused Node tests exercise the gateway and manifest; `node frontend/scripts/mako-local-integration.mjs` exercises the real auth/RxDB/Dexie application code against deterministic HTTP and in-memory IndexedDB. Real browser smoke checks remain required. Before opening a PR, run `cargo test`, `cd frontend && npm run lint`, `cd frontend && npm run build`, and perform a manual smoke test of key flows: accounts, transactions, positions, analytics/performance, Excel import, SnapTrade import when credentials are available, and admin cache actions.

When adding tests:
- Place Rust unit tests near implementation (`#[cfg(test)]` blocks)
- Put cross-crate calculation regression tests under `crates/core/tests/`
- Use `*.test.ts`/`*.test.tsx` naming under `frontend/src/` for future frontend tests

## Commit & Pull Request Guidelines
This worktree may contain local changes from other agents or manual work. Do not revert unrelated changes. Use Conventional Commit style as a default (`feat:`, `fix:`, `chore:`).

PRs should include:
- clear problem/solution summary
- affected paths, for example `src/api/transactions.rs`, `crates/core/src/positions.rs`, or `frontend/src/pages/Transactions.tsx`
- validation steps and results
- screenshots for UI changes

## Security & Configuration Tips
Retained native rollback config is loaded from `.env` when present and then environment variables. Defaults are `MAKO_CONFIG_PATH=mako/runtime.json`, `ROBINLAB_RUNTIME_DIR=.local/mako-runtime`, `MAKO_WORKER_SESSION=.local/mako-runtime/worker-session.json`, `HOST=127.0.0.1`, and `PORT=3000`. Runtime directories must be 0700 and worker sessions 0600.

Optional integrations use:
- `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, and `SNAPTRADE_SYNC_INTERVAL_MINUTES`
- `FMP_API_KEY`, `TWELVE_DATA_API_KEY`, and `YAHOO_FINANCE_ENABLED` for market data
- MakoDB is authoritative. Normal provider/service credentials are Mako function secrets, never frontend environment values.
- Setup is documented in `README.md`; hosted deployment and compute rollback are documented in `mako/serverless/README.md` and `mako/serverless/cutover-runbook.md`.
- Exactly one Mako dispatcher schedule owns hourly imports and price refresh. Do not start the retained native timer alongside it; rollback must pause cloud admission and reconcile pending jobs first. Never restore an old SQLite/export snapshot over accepted Mako writes.

Do not commit secrets, local `.env` values, generated database backups, or dev logs.
