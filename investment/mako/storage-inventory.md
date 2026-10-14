# Persistence inventory

`table-map.json` is the source field allowlist and destination classification. It is consumed by the snapshot tools. A field outside the allowlist is not exported automatically. `redacted` values require separate handling: credential values must use the secret-transfer path; provider error text must be sanitized before migration because historical errors can contain request credentials.

## Repository boundaries

| Domain | Existing SQL sites | Cloud access pattern |
| --- | --- | --- |
| Accounts/tickers | `src/api/accounts.rs`, `tickers.rs`, `services/ingest.rs`, `api/snaptrade.rs` | Pinned portfolio dataset; uniqueness by code/symbol; IDs allocated in head publication |
| Transactions/options | `src/api/transactions.rs`, `services/ingest.rs`, `api/snaptrade.rs` | Pinned dataset; filter/join locally; stage all related mutations and publish one head |
| Positions/analytics | `src/services/portfolio.rs`, `analytics.rs`, `src/api/positions.rs`, `analytics.rs` | One pinned dataset per request; calculations consume typed rows |
| Imports | `src/api/import.rs`, `src/services/import.rs`, `ingest.rs`, `src/api/snaptrade.rs` | Normalize and retain occurrence counts; commit portfolio/mapping/watermark branches together |
| Prices/logs | `src/services/market_data.rs`, `src/api/prices.rs`, `admin.rs` | Indexed date/provider/symbol pages and point reads; conditional cache updates |
| Splits | `src/services/splits.rs` | Portfolio split facts plus point-read fetch metadata |
| Connection secrets | `src/api/snaptrade.rs` | Worker-only credential records; never owner replication |
| Plumbing | `src/db/schema.rs`, `models.rs`, `src/api/routes.rs`, `src/error.rs`, `src/main.rs` | Typed repositories, cloud errors, explicit config; SQL kept only in migration tooling |

Versioned portfolio partitions and manifests are read by content identity, not by an unindexed collection scan. The head publishes public/private branches together. Accounts/tickers/transactions keep their numeric business IDs; transport identities are independent strings. Composite source keys are encoded from ordered key arrays, never ambiguous string concatenation.

## Retention and indexes

- Preserve all ledger, split, snapshot, mapping, balance, and watermark history at migration. No data pruning is part of cutover.
- Preserve old heads/manifests and all reachable partitions until rollback and operation-replay retention have been qualified; garbage collection is deferred.
- `historical_prices`: `(symbol, price_date)` and `(price_date, symbol)` indexes support per-symbol series and coverage/date maintenance. Canonical composite identity supports point lookup.
- `latest_prices` and `split_fetch`: symbol identities support point lookup; maintain a bounded symbol inventory for complete enumeration.
- `provider_requests`: `(requested_at, id)` and `(provider, requested_at, id)` support date windows and provider summaries. Preserve sanitized historical records initially; do not make an implicit retention cut.
- `private_credentials`: one record per SnapTrade identity, accessed by the worker; service scopes must not permit owner reads.
- `schema_migrations`: archive with the source snapshot, not in the runtime app dataset. MakoDB collection schema versions and provisioning metadata replace it.

## Reconciliation rules

Compare all allowlisted fields without rounding money or collapsing repeated trades. Normalize transport representations only (numeric strings, SQLite/Postgres boolean representation, and equivalent UTC timestamps). Unknown columns, unavailable tables, unsafe IDs, duplicate keys, and broken references are reported rather than treated as empty data. Source-only SQLite migration history does not create a false cloud discrepancy. Cloud tombstones are counted and excluded from the live dataset comparison.

An inventory or zero-difference comparison does not authorize cutover: credential transfer, formula parity, paused writers, hosted qualification, and rollback rehearsal remain separate requirements.

`broker_balances` is a derived public partition table containing only numeric account ID and balance, published and verified against the private mapping branch in the same head. It is not an additional source table or a replacement for snapshot history.
