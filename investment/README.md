# Rational Investment

Rational Investment tracks stock and option portfolios across brokerage accounts. React reads
an authenticated MakoDB replica through RxDB/Dexie. Mako Cloud functions own API
writes, Excel imports, SnapTrade sync, prices and cache maintenance. Shared Rust
logic runs as Wasm in the browser and functions.

## Run locally

```sh
cd ..  # Rational repository root
npm ci
npm ci --prefix investment/frontend
npm run dev
```

Open http://localhost:5173/investment/ and use your Rational sign-in. One Vite
process serves both apps, including hot reload. API calls go directly to the configured Mako
`robinlab-api` function; there is no localhost backend fallback. Configuration
identifiers/public project key are in `frontend/src/api/mako-config.json` and
`mako/runtime.json`. Service/provider secrets belong in Mako secret storage.

Long imports and maintenance continue as durable cloud jobs after a browser
reload or shutdown. The UI shows their progress and waits for local replication
of the committed portfolio or complete price generation.

## Verify changes

```sh
cargo test
node --test mako/serverless/tests/*.test.mjs
node --test frontend/tests/*.test.mjs
cd frontend && npm run lint && npm run build
```

Run `openspec validate --all --strict` from the repository root and perform real
browser checks for affected flows. Rebuild function Wasm with
`scripts/build-function-wasm.sh` after shared-domain changes.

## Operations

The migration runbook at `../docs/investment-migration.md` records the active environment and cutover state. Exactly one
Mako dispatcher runs every minute, admitting each hour's SnapTrade sync and price
refresh once and advancing bounded job phases. This cadence means larger jobs
can take several minutes; browser activity is not required.

See [hosted runtime and evidence](mako/serverless/README.md) and
[cutover and rollback](mako/serverless/cutover-runbook.md). The native Rust server
is retained for tools and explicit rollback with a newly provisioned worker binding, and must not be started alongside
cloud scheduling. Supabase files and SQLite snapshots are historical artifacts.
Never restore them over newer Mako data.
