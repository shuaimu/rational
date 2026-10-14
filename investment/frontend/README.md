# RobinLab frontend

React/TypeScript with shared Rust calculations compiled to Wasm. Reads come from authenticated MakoDB replication into scoped RxDB/Dexie databases. Writes go through the Rust API at relative `/api` URLs.

```sh
npm ci
npm run dev       # http://localhost:5173; API proxy to 127.0.0.1:3000
npm run lint
npm run build
node scripts/mako-local-integration.mjs
```

See [migration and runtime setup](../mako/README.md) before starting the backend. The cloud migration is complete; a fresh browser signs in and downloads the verified portfolio and price history before displaying data. Subsequent loads reuse the local cache.

Public scope configuration is in `src/api/mako-config.json`; schemas are copied from `mako/schemas` by `scripts/update-mako-schemas.mjs`. Service credentials and worker sessions must never enter frontend configuration. The application owner login is distinct from the MakoDB developer CLI account.

The local integration harness tests the real auth adapter and application replication code using deterministic HTTP responses and in-memory IndexedDB. It makes no cloud requests or portfolio writes. Real browser sign-in, offline, and reconnect smoke checks are also required before cutover.

RxDB and the MakoDB adapter use Dexie 4.4.2; keep the app's direct dependency aligned to avoid loading two incompatible copies. The official adapter is pinned to its source archive because the documented npm package is not published yet.
