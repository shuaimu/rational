# RobinLab serverless runtime

Normal operation uses Mako Cloud functions and the published Rational website.
Vite is only needed for frontend development; the Rust API and native timer are stopped. The
frontend has no localhost API proxy or automatic fallback. Supabase is obsolete.

## Deployed runtime

- Destination: Rational environment `env_482f584a064bb6dc32c443f7c746c5af`.
- `robinlab-api` version 7: owner-authenticated API, scoped storage credentials,
  durable commands, bounded uploads and daily automatic quote admission.
- `robinlab-jobs` version 5: private scheduler entrypoint, bounded job phases,
  retries, provider rate limits, captured inputs and retention cleanup.
- Exactly one dispatcher, `sch_u0i2krq8abg26q4f`, runs **hourly**, using
  `0 * * * *` in UTC (also recorded in `jobs/schedule.json`). It admits one
  automatic SnapTrade job and one automatic quote-refresh job per **UTC day**.
  Opening Positions shares the same daily quote identity. No browser or local
  worker is required; the source environment's writers remain closed.
- Previously accepted hourly jobs retain their identities and checkpoints.
  Manual imports retain their own command identities and use the hourly worker.
- Limits: 5 s CPU, 25 s wall, 256 MiB memory, 1 MiB request and response,
  API concurrency 16 and worker concurrency 1.

Service and provider secrets reside in Mako secret storage. Public runtime
identifiers are in `mako/runtime.json`; browser config includes only the public
project key and expected owner/environment scope. The protected local worker
session is retained exclusively for native tools and compute rollback.

The Brokers status endpoint reads only hash-verified private brokerage metadata
from one pinned head, avoiding a full transaction-history load for a timestamp.

The API concurrency was raised from 2 to 16 after live runtime rejections showed
that ordinary foreground status reads competed with background job recovery.
The browser now uses one background per-job read at a time, with a minute between
reads of the same job and five minutes between full discovery scans. Explicitly
awaited queued/checkpointed jobs poll once per minute. This changes observation
traffic, not the durable cloud job schedule or accepted commands.

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

The dispatcher executes one bounded phase per hour. Large imports, cache scans
and provider work can therefore take many hours or days, especially behind an
existing backlog. Daily admission is not a daily completion guarantee. `retry` with no error
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

Historical source qualification (before the Rational environment migration) includes:

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
  At that historical cutover, repeated ticks retained one job per kind per UTC hour
  and advanced checkpoints. The current daily cadence supersedes that frequency.

Protected screenshots, reports and exports are in `.local/mako-serverless/`, with
final evidence under `cutover-20260927/`. They contain private portfolio data and
must not be committed or attached to public issues. See [compute rollback](cutover-runbook.md).

### Automatic backlog reconciliation

Each hourly dispatcher pass retains the newest never-started automatic broker,
quote and cache-report request and cancels superseded automatic requests. Only
recognized generated command identities with exact automatic inputs and queued,
zero-attempt state are eligible. Manual imports, started jobs, checkpoints and
publishing work remain unchanged. Cancelled rows retain their identities and the
reason `superseded_automatic_request`; no portfolio data is removed.

Cleanup inspects at most five 200-row pending pages and cancels at most 32 jobs
with revision comparison and four concurrent storage requests. If inspection is
incomplete it reports `incomplete: true` and cancels nothing. Inspect the
`automatic_job_cleanup` log event for counts and conflicts. Large backlogs require
operator inspection rather than silently exceeding those bounds.

The existing trusted scheduler can run `/maintenance/automatic-jobs?dryRun=true`
for a preview or `/maintenance/automatic-jobs` for cleanup without advancing
financial jobs. Restore the schedule path to `/` after maintenance; keep the
hourly cron, single dispatcher and worker concurrency unchanged. Public requests
cannot supply the trusted scheduler headers. The October 15 cleanup cancelled
339 redundant requests, leaving six pending jobs, including one manual import
and two checkpointed jobs.

A completed browser discovery removes stale cloud-only queued entries. Partial
or failed discovery does not remove anything, and local command receipts remain
tracked until their terminal result is recovered. The operations panel separates
queued, running and waiting-to-resume counts.

### Pending queue index and freshness

Before deploying API version 7, create the additive index described by
`indexes/jobs-pending.json`:

```sh
mako-cloud indexes create robinlab_jobs --name by_state_id --version 1 \
  --field state:ascending --field id:ascending --project "$MAKO_PROJECT_ID" \
  --env "$MAKO_ENVIRONMENT_ID" --profile robinlab
```

Wait for the index to become active. `/jobs` reads at most 32 rows in each of
five pending states (including needs-attention) with two storage requests in
parallel. Its composite cursor continues only states with more rows. Legacy
cursors still finish using their prior ordering during deployment. Completed,
failed and cancelled history is never scanned on a fresh request.

The browser labels restored entries as saved while checking and after a failed
refresh, with an explicit retry control. A successful discovery restores the
current queued/running/waiting summary. Failed discovery retries after a minute;
successful periodic checks remain five minutes apart.
