# RobinLab serverless runtime

Normal operation uses Mako Cloud functions in Rational / robinlab. Only the React
Vite server runs locally; the Rust API and local hourly timer are stopped. The
frontend has no localhost API proxy or automatic fallback. Supabase is obsolete.

## Deployed runtime

- `robinlab-api` version 6: owner-authenticated API, scoped storage credentials,
  durable command identities, bounded uploads and cloud job admission.
  Bundle `sha256:6a1cf0225fc0e4b29116c4547eeadff2a17d36c4f9e416423044ce39925fdb1f`.
- `robinlab-jobs` version 7: private scheduler entrypoint, bounded job phases,
  retries, provider rate limits, captured inputs and retention cleanup.
  Bundle `sha256:e48f1e1981e436c613d9dbc032fbde74ce012333420e96ebb5371b6543e5ab07`.
- Dispatcher `sch_eds861nfcp7vmojq` runs every minute. It admits one SnapTrade job
  and one quote-refresh job per UTC hour and advances pending work. No browser or
  local worker is required. The no-data qualification schedule remains paused.
- Runtime v1.74.3; limits: 5 s CPU, 25 s wall, 256 MiB memory, 1 MiB request and
  response, API concurrency 2 and worker concurrency 1. The platform does not
  report exact CPU or peak isolate heap measurements.

Service and provider secrets reside in Mako secret storage. Public runtime
identifiers are in `mako/runtime.json`; browser config includes only the public
project key and expected owner/environment scope. The protected local worker
session is retained exclusively for native tools and compute rollback.

## Architecture and recovery

`crates/domain` holds pure repository formats, identities, mutations, analytics,
workbook parsing, provider normalization and import planning. `crates/function-wasm`
exposes the versioned JSON interface. Neither imports host-only libraries.
Transport, auth, captured time, storage I/O and provider HTTP remain in adapters.

Portfolio writes stage immutable documents and compare-and-swap the head. A
command receipt retains its original result and version, including after a
transaction is deleted. Retries must retain the original idempotency key.

Long operations persist to private job/input collections. Claims are fenced by
revision and generation; inputs and captured provider responses survive cold
invocations. Registration never blindly repeats an ambiguous remote call: an
uncaptured result requires review. The active personal SnapTrade configuration
does not require commercial user registration.

Cache maintenance seals a mutation plan before writing and serializes cloud
writers through a durable job lane. `cache_status` publishes the complete latest
view plus historical row count/digest. RxDB waits for that complete generation
before replacing its saved prices. Writes wait for portfolio/cache catch-up;
HTTP 429 retries retain the same command ID and stop on an owner change.
A 30-second checkpoint refresh also recovers missed live notifications.

Uploads are capped at 50 MiB, transferred in 256 KiB chunks, sealed by digest and
bound to one import. Workbook expansion is capped at 64 MiB, XML parts at 16 MiB,
512 archive entries, XML nesting 128 and worksheet ranges 500,000 cells. The
browser retains the import ID with the upload across reload/background completion.
Terminal captures expire after seven days through bounded idle cleanup. Durable
receipts and response artifacts remain; active and needs-attention jobs are protected.

The dispatcher executes one bounded phase per minute. Large imports, cache scans
and hourly provider work can therefore take several minutes. `retry` with no error
also represents a normal checkpoint waiting for its next phase. Admin summaries
are complete asynchronous captures and display their `as_of` timestamp.

## Build and validation

Use wasm-bindgen-cli 0.2.108 with a Rust toolchain supporting wasm32:

```sh
WASM_BINDGEN=/path/to/wasm-bindgen scripts/build-function-wasm.sh
cargo build -p robinlab-domain --example invoke
node scripts/package-function-api.mjs
node scripts/package-function-jobs.mjs
node --test mako/serverless/tests/*.test.mjs
node --test frontend/tests/*.test.mjs
```

Deploy the corresponding bundle/entrypoint with the Mako CLI and reviewed
configuration. Keep the binary Wasm asset and generated `.d.ts` together.
Never expose the internal domain interface as an arbitrary owner storage API.

Qualification includes:

- 78 native/domain/core Rust tests, 30 function tests and seven frontend regression
  tests, plus frontend lint/build and strict OpenSpec validation.
- Cold complete portfolio traversal: 211 documents / 3,074,814 bytes, full
  decode/re-encode in 7.8 seconds. Immutable staging in bounded 32-document pages.
- Representative 8,000-row workbook parse in 282 ms; authenticated 50 MiB transfer
  and parse in roughly 7.5 seconds, with 53,936,128 bytes Wasm linear memory.
- Anonymous/foreign/worker denial, owner auth, browser CORS/version headers,
  gateway idempotency forwarding, declared provider egress and forged schedule
  header rejection. Mako Cloud PR #8 is deployed and verified.
- Live SnapTrade preview matches native output; Excel replay, head contention,
  interrupted claims, registration uncertainty and cache conflict recovery pass.
- Full cache usage, coverage and trends match native results over 38,148 rows.
  SPY prefetch reused 19 covered bars; a separate authenticated hosted Twelve Data
  probe verified a real quote. Yahoo returned 21 normalized VIGIX bars.
- All four synthetic cache rows were independently verified deleted. Expired
  captures/chunks were removed while receipts and required results survived.
- Fresh quiescent export at version 42 has matching live financial roots and ID
  counters; native/Wasm encoding and six financial report checks pass. The empty
  browser import advanced to version 43 without changing financial roots/counters.
- Real Chrome verified sign-in, route screens, broker discovery, Admin results,
  upload, job reload/recovery and cancellation. Isolated real-IndexedDB fixtures
  cover offline reopen, auth renewal/revocation and missed-notification recovery.
- Post-switch writes advanced through versions 44–46 with port 3000 absent.
  Original-result replay works after deletion; the synthetic transaction is absent.
  Existing Excel import replay returns its original result without re-importing.
- Automatic, non-manual dispatcher invocations run worker version 7 successfully.
  Repeated ticks retain exactly one job per kind per UTC hour and advance checkpoints.

Protected screenshots, reports and exports are in `.local/mako-serverless/`, with
final evidence under `cutover-20260927/`. They contain private portfolio data and
must not be committed or attached to public issues. See [compute rollback](cutover-runbook.md).
