# Serverless migration contract inventory

The source is the Mako-only router in `src/api/cloud.rs`, with integration and
admin handlers in `cloud_snaptrade.rs` and `cloud_admin.rs`. Legacy SQLite routes
remain rollback/reference code, not the active persistence layer. Inventory
captured 2026-09-26 before any compute cutover.

## Common contracts

All routes require the configured active owner JWT. Anonymous/expired/revoked
sessions get 401; another application identity gets 403; unavailable auth/storage
gets 503. Business validation/import errors use 400, absent resources 404,
identity reuse with changed input or exhausted head contention 409. Error JSON
is `{error: string}`. Framework body/query/multipart failures also need coverage.
Portfolio writes return JSON with `x-robinlab-version` set to the ORIGINAL
command version on replay. `Idempotency-Key` is 16–128 ASCII alphanumeric,
underscore or dash; canonical request hash binds operation and input. Native
canonical JSON and SHA-256 are authoritative, including float serialization.

| Method/path (under /api) | Input / output contract | Command operation |
| --- | --- | --- |
| GET /accounts; GET /accounts/{id} | Account[] / Account, sorted by code | read |
| POST /accounts | CreateAccount → Account | create_account, raw JSON |
| GET /tickers | Ticker[] | read |
| GET /transactions | TransactionFilter → PaginatedTransactions | read |
| GET /transactions/{id} | numeric ID → Transaction | read |
| POST /transactions | CreateTransactionRequest → Transaction | create_transaction, raw JSON |
| PUT /transactions/{id} | UpdateTransactionRequest → Transaction | update_transaction, {id,body} |
| DELETE /transactions/{id} | numeric ID → {deleted:id} | delete_transaction, {id} |
| POST /transactions/roll-option | RollOptionRequest → shared option result | option_roll, raw JSON |
| POST /transactions/close-option | CloseOptionRequest → shared option result | option_close, raw JSON |
| POST /transactions/expire-option | ExpireOptionRequest → shared option result | option_expire, raw JSON |
| POST /transactions/assign-option | AssignOptionRequest → shared option result | option_assign, raw JSON |
| POST /import/excel | multipart workbook, 50 MiB HTTP ceiling → ImportResult | import_excel, {sha256: workbook digest} |
| GET /analytics/summary | PortfolioSummary | read |
| GET /analytics/performance | PerformanceData[] | read |
| GET /analytics/ticker-pnl | optional account_id → TickerRealizedPnl[] | read |
| GET /portfolio/version | {version: integer} | pinned head |
| GET /prices | LatestPrice[], sorted by symbol | cache read |
| GET /positions; GET /positions/{id} | account/include_closed filters → enriched Position[] | pinned portfolio + prices |
| GET /analytics/accounts-performance | AccountPerformance[] | portfolio, balances, snapshots, historical/latest prices, today |
| GET /analytics/yield | YieldReport | portfolio, prices, today |
| POST /snaptrade/register | {} → personal/already registered/registered result | register_snaptrade, {} |
| GET /snaptrade/connect | optional broker → {redirect_uri} | signed provider request, read access |
| GET /snaptrade/accounts | {accounts:[provider metadata + linked_account_code]} | discovery may commit metadata; discovery hash binds head + captured accounts |
| POST /snaptrade/accounts/{sid}/link | {account_id} → {status,account_code} | link_snaptrade_account, {snaptrade_account_id,account_id} |
| GET /snaptrade/status | {last_synced_at: string or null} | maximum linked mapping updated_at |
| POST /import/snaptrade | SyncQuery → preview/apply/roll-detection summary | import_snaptrade, complete SyncOptions only for apply without roll_detect |
| GET /admin/api-usage | ApiUsageSummary | complete indexed provider history aggregation |
| GET /admin/cache-coverage | CacheCoverageQuery → CacheCoverageResponse | complete cache aggregation |
| GET /admin/cache-price-trend | CachePriceTrendQuery → CachePriceTrendResponse | bounded symbol/date results |
| POST /admin/api-usage/cache/clear | CacheClearRequest → {scope,deleted_rows} | all/today/older_than_days/symbol, then rebuild latest |
| POST /admin/api-usage/cache/prefetch | PrefetchRequest → PrefetchResponse | symbols, days clamped 1–3650 |

Exact field definitions are in `src/db/models.rs`,
`src/services/transaction_requests.rs`, `src/api/admin.rs`, `src/api/snaptrade.rs`
and `frontend/src/api/types.ts`. They are retained as extraction inputs; absent
versus explicit null update fields, duplicate import occurrences, fees/signs,
option full-lot validation and supplied UTC time must not change.

## Process state to replace

- Worker JWT file + OS file lock (`mako_client.rs`): replace with function service
  credentials; never install laptop worker credentials into functions.
- Portfolio writer/loader/history/content mutexes (`mako_repository.rs`):
  optimizations only; head revision CAS + durable command chain remain authority.
- `snaptrade-registration.json` + process registration mutex: cloud admission,
  capture, reconciliation/needs-attention on ambiguous external creation.
- `scheduled-sync.json`: stable UTC-hour command, private durable job state.
- Hourly Tokio timer: dispatcher cron, exactly one scheduler at cutover.
- Cache maintenance mutex/recovery marker: private coordination and durable
  invalidation/rebuild job; do not expose a partially rebuilt latest generation.
- In-process provider limiters and sleeps: shared next-allowed-at records and
  resumable jobs. No invocation survives via spawn/background work.

## Credentials and external transport

Names only: SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY,
TWELVE_DATA_API_KEY, optional FMP_API_KEY. Existing gateway secrets:
ROBINLAB_SERVICE_KEY, ROBINLAB_CACHE_KEY, ROBINLAB_LOG_KEY,
ROBINLAB_WORKER_ID (worker ID is gateway authorization, not new function auth).
SNAPTRADE_SYNC_INTERVAL_MINUTES is 60 for the current process.
YAHOO_FINANCE_ENABLED is false. Twelve Data is enabled; FMP is unconfigured.
SnapTrade and Twelve Data HTTPS hosts are api.snaptrade.com and
api.twelvedata.com. FMP, if configured later, uses financialmodelingprep.com.
Yahoo/Python price quotes are excluded from normal serverless operation. Stock
split refresh is independently enabled in `src/services/splits.rs`: preserve its
HTTPS calls to `query1.finance.yahoo.com`, shared normalization and weekly cache.
The quote flag does not disable this split feed.

## Retained baseline

Private sealed evidence is under `.local/mako-migration/final-20260925/`:
`final-clean-cloud-export.json`, `final-clean-comparison.json`,
`final-clean-cloud-export.financial-verification.json` and `cutover-complete.json`.
That baseline is portfolio version 26, 7808 transactions, 38148 historical prices,
113013 provider requests. The hourly scheduler may advance current data;
recapture a quiescent export before cutover. Do not republish this baseline.
Immutable format version 1; partitions target 30 KiB, maximum 32 KiB; manifest
fanout 16; branch limits 8192 documents / 64 MiB. Numeric IDs and command history
must survive unchanged. Compute rollback uses CURRENT cloud state.
