## Context

See proposal.md for motivation. The current household CSV importer selects one pre-existing account, preserves a small set of fields and performs browser-driven writes. The live Plaid implementation can create accounts or explicitly map bank accounts to existing ones; it maintains per-account cursors and reconciles balances. It currently identifies transactions only by provider IDs, so matching an existing account does not itself prevent duplicate imported history.

Monarch documents transaction columns `Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags`, with expenses negative and income positive. The actual current export additionally includes `Owner, Reviewed, Id`. `Id` values are unique string transaction identities; never convert them to JavaScript numbers. `Reviewed` uses blank, `Reviewed` and `Needs Review`; preserve the distinction, treating blank as unspecified. Its balance export uses `Date, Balance, Account`. Neither format establishes a stable account ID, account type or currency. Source: https://help.monarchmoney.com/hc/en-us/articles/4409682789908-Import-data-manually-from-banks-or-other-finance-apps . The signed-in UI also offers Download CSV on Transactions and Accounts. Do not assume unexported pending, split-parent or hidden flags can be recovered.

The household app and Investment app share deployment but not ledgers. Raw financial exports remain in private storage and local ignored files. Existing dirty work in the checkout must be preserved. The hourly dispatcher and daily bank refresh preference remain unchanged.

## Goals / Non-Goals

**Goals:**
- A reviewable, resumable Monarch migration followed by bank linking to those same account identities.
- Deterministic retry behavior, source provenance and verifiable counts and amounts at every phase.
- Explicit ambiguity handling for duplicate account names, repeated transactions and bank overlaps.

**Non-Goals:**
- Reconstructing unavailable Monarch data, transferring credentials from Monarch, or buying a different Plaid plan.
- Importing investment trades into Rational Investment, changing its writer environment, or expanding its household access.
- Reconstructing historical bank observations that were never supplied. Historical transaction estimates remain explicitly distinct from reported balances.
- Automatic irreversible erasure of partially imported data. Cancellation stops future processing and reports accepted records.

## Decisions

### 1. Dedicated preview, shared strict parser

Add a Monarch mode beside the generic CSV importer. Share pure parsing and validation between the preview and cloud validator. Recognize exact supported headers; reject malformed quoting, inconsistent columns, invalid dates and unsafe money values with line-specific errors. Keep original strings and normalized financial fields separately. Never silently truncate notes or other source values to fit a schema; flag limits in preview.

Group by exported account name, preserving exact names. The user chooses a new account or an existing account, type, currency and category kinds. Previously observed source metadata may suggest values but does not authorize writes. A known collision in names or incompatible balance records requires per-account exports or explicit resolution; name equality is not a universal identity key. Accounts with no exported transactions can be selected from the balance file and are visibly labeled as such. All proposals remain unwritten until the final preview is accepted.

Alternative rejected: importing the all-account export through the single-account form would mix unrelated ledgers and discard source metadata.

### 2. Durable upload and import phases in Mako Cloud

Use a private staging/job collection that is never included in RxDB replication. A job contains household and actor IDs, an immutable manifest hash, selected mappings, upload hashes, phase/checkpoint, counters and sanitized errors. Bounded chunk records carry source rows; public status is returned by owner/editor-authenticated function routes. Keep staging collection policies deny-by-default to app users, with narrowly scoped function service access. No raw CSV, bank credential or signed download URL belongs in logs.

Proposed routes on the household cloud service: start, upload-chunk, seal, status, advance and cancel. Validate membership for every operation and revalidate account ownership/type/currency before writes. Seal verifies chunk completeness, checksums and the immutable manifest. A reused request identity with changed content fails. States are uploading, validating, importing, reconciling, needs-review, complete, failed and cancelled.

Phases use stable account, taxonomy, transaction and provenance identities. Persist intent before multi-document operations and verify committed effects on replay, using expected revisions. No full-file write is one transaction, and no browser timer owns progress. Start can request an immediate bounded cloud phase; the existing hourly dispatcher advances pending jobs within its deadline. A visible Continue action can request another bounded phase. Do not add a minute schedule. Processing counts and estimated remaining batches make the hourly cadence explicit for large imports.

Alternative rejected: a long browser loop would lose progress on closure and repeat the local-runtime migration problem. A single unbounded function request would exceed execution limits.

### 3. Source provenance and balance treatment

Store import batch, Monarch transaction ID, source account identity, financial fingerprint, occurrence number and original statement as explicit provenance. Preserve category, merchant, notes, tags, owner label and review status. Map owner labels to household members only with explicit selection; labels never grant membership or permissions. Create or match taxonomy deterministically; category-kind confirmation determines transfer treatment, never amount sign alone. User-authored metadata takes precedence on re-import and bank updates.

A balance at date D implies opening balance = source balance at D minus all imported signed transactions on or before D, after applying the account's confirmed asset/liability convention. Transactions after D affect the later displayed balance separately. Without balance evidence, require an explicit opening-balance choice and label the result unverified. Partial jobs remain visibly incomplete and cannot be linked to Plaid until their account's import and reconciliation finish.

Do not overwrite unrelated existing account opening balances. Adding history to a populated destination requires a preview of the ledger and balance effect and an explicit reconciliation choice.

### 4. Re-import identity preserves multiplicity

The same file hash and manifest resolve to the same job. When `Id` is present, use a household-scoped Monarch transaction identity and maintain its source account mapping; changed account destinations or conflicting financial fields require review. New exports with the same IDs do not create additional transactions. IDs remain strings throughout parsing, hashing and persistence.

For older exports without IDs, compare per-account financial fingerprints using signed amount, date and normalized original statement (falling back to merchant), with occurrence counts. An exact replay of a multiset is a no-op; two identical source purchases remain two occurrences. Metadata differences do not silently change user edits. Changed descriptions or conflicting occurrence evidence produce review candidates rather than claiming certainty. Never use the legacy fingerprint fallback in preference to a supplied source ID.

Alternative rejected: a set of date/amount/description keys collapses legitimate identical purchases. Hashing every CSV byte as the only transaction identity duplicates all rows on a later export.

### 5. Bank identities are attached to imported transactions

Reuse the existing explicit Plaid account mapping and add a link action on account detail with that account preselected as a candidate. After authorization, require confirmation of returned bank identity; never infer it from name alone.

For each posted provider transaction, first resolve an existing provider-identity mapping. Otherwise find imported candidates only within the mapped account, with exact signed amount and currency. Automatically rank matches within three posting days by normalized original-description evidence, then merchant evidence, date proximity and stable transaction ID. Require exact signed amount and currency. Identical candidates are allocated one-to-one to provider occurrences; a candidate claimed by another provider identity is unavailable. Matching descriptions ignore punctuation and case, but generic words such as payment or transfer alone do not qualify. A bank row with no qualifying unclaimed candidate is created as a separate transaction.

Persist a match intent linking provider identity to the existing transaction before updating it. Replay completes this intent. Keep the transaction ID and imported/user annotations; track provider financial fields separately for subsequent corrections or removals. Persist each provider identity independently, so a replay after a cursor failure cannot duplicate the transaction. Preserve original import provenance when provider corrections are applied. Keep later manual financial edits, valid split totals and user deletions as local overrides while recording the newest bank fields privately; these do not create a blocking review task.

Every provider row is reconciled automatically; there is no bank-overlap review UI or user decision queue. Provider cursors advance only after durable identity and ledger effects. Existing staged reviews and interrupted intents are drained in bounded cloud sync phases, even when the provider cursor has already passed those rows. Daily sync completes after both provider history and automatic reconciliation finish. Source balance observations are recorded independently of transaction matching, as specified in the later daily-balance revision.

Alternative rejected: a blanket latest-import-date cutoff loses delayed transactions and is unsafe when an export includes future-dated manual entries. Unconditional provider-ID insertion duplicates source history.

### 6. Deployment and compatibility

Use additive schema changes with explicit collection versions and local replica migrations where required. Publish a frontend capable of handling job status and overlap review before enabling the new import routes for normal users. Keep the old generic CSV path working. If a schema or client version cannot safely process the new flow, fail with an update-required message rather than partially importing.

Existing-account Plaid mapping is present in the current local UI and cloud deployment; the published Pages frontend has not yet received that new UI. Treat frontend publication and a real browser smoke check as explicit tasks, not as already completed.

## Risks / Trade-offs

- CSV account names lack durable identifiers → explicit mapping and collision checks; never conflate same-name accounts.
- Plaid and Monarch descriptions/dates differ → amount/currency gates, source and merchant evidence, a three-day posting window and one-to-one claims. Different descriptions remain separate instead of guessing from amount alone.
- Large CSVs exceed request or execution limits → bounded uploads, indexed page reads, checkpointed phases and scale tests above twenty thousand transactions.
- Imports stop midway → retain accepted data and durable progress; cancellation is not rollback.
- Slow hourly continuation → show progress and provide a manual bounded Continue action without adding local workers or changing automatic cadence.
- Source exports omit data → preview documents omissions and never promises a full Monarch clone.
- Existing user edits race with the importer → optimistic revisions and revalidation; conflicts require review rather than overwrite.
- Historical source deletion or provider removal → retain provenance/tombstones and preserve conflicting manual edits automatically; do not resurrect user-deleted records during retries.

## Migration Plan

1. Complete the separately authorized cleanup of recorded manual snapshot IDs and verify cloud/local/published results; preserve unrelated households.
2. Build and validate parser, manifest, job engine and duplicate-resolution behavior against synthetic fixtures; keep actual exports private.
3. Add schemas/indexes/service scopes and deploy compatible cloud routes without admitting imports from obsolete clients.
4. Publish the preview, progress, existing-account link and overlap-review UI; exercise it in Chrome against a disposable test household.
5. Preview the user's exported data, resolve source ambiguity and validate per-account counts and balances before admission.
6. Import history and verify durable completion before authorizing any Plaid feed. Link one institution first, inspect overlaps and balances, then expand.
7. If rollback is needed, stop admission and pause new worker phases, preserve job records and accepted ledger writes, and return to the previous read-compatible frontend. Never restore a stale snapshot over accepted data.

## Open Questions

- The inspected export contains only single-tag values. Confirm Monarch's multi-tag encoding using an official example or a disposable source fixture before accepting multiple tags; unknown encodings must remain intact as source text and require preview resolution rather than being split speculatively.

### Implementation evidence and continuation behavior

At the initial import rollout, public ledger schemas remained unchanged. Private `import_records` holds upload chunks, job checkpoints, account readiness, source metadata, and provider identities; authenticated function routes expose only household-scoped status and review records. That initial import rollout needed no additional RxDB collection or local schema migration; the later daily-balance revision below adds a separate public observation collection.

The existing hourly dispatcher may request an opt-in Mako durable continuation after a successful import phase. This advances admitted history in bounded cloud invocations while the browser is closed; it does not increase the daily bank refresh cadence or add a recurring schedule. Continuations stop when no import phase progressed, when work needs review, or at the platform chain limit, and the hourly dispatcher remains recovery.

The actual transaction export contains only single-tag values. The preview defaults to preserving each tag cell intact and offers explicit comma/semicolon interpretation for reviewed exports; no undocumented delimiter is guessed.

### Bounded import concurrency and measurements

Validation and ledger import process at most eight rows concurrently within the existing invocation deadline. Rows with the same source identity (or legacy occurrence fingerprint) remain ordered. Each batch drains all admitted work before reporting failure or advancing its contiguous checkpoint; replay recognizes completed rows by their original chunk/row position. Account and taxonomy lookups are shared only within a phase, so later phases recheck cloud state. The function itself retains concurrency one and the existing hourly schedule/continuation policy.

Private job records retain phase row counts, elapsed time, database operation counts and aggregate durations, without source values or credentials. Live measurement found per-row network operations dominated runtime; the in-memory scale regression established correctness but did not measure cloud throughput. Individual service mutation responses must explicitly reject revision conflicts rather than count them as applied writes.

### Custom source categories

The user chose to retain Buy/Sell as custom types. The import manifest accepts `custom`, preserves the exact source category label, and leaves optional public `category_kind` unset instead of assigning expense, income, or transfer. Categories displays this as custom. Amounts, balances, notes, and source provenance remain unchanged. Existing cash-flow behavior for categories without a standard kind continues to follow signed amounts; custom selection does not silently hide rows as transfers. No public schema migration is needed.

### Automatic bank reconciliation revision (2026-10-18)

The user replaced the bank-overlap approval workflow with automatic reconciliation. This supersedes the historical manual bank-review rollout steps above; CSV source-record conflicts remain a separate import concern. Existing review rows are migrated by the normal serverless sync, with no browser worker or schedule-frequency change.

### Reported balances and estimated history (2026-10-18)

Use a separate household-scoped `account_balance_snapshots` collection for daily provider observations, keyed by account and UTC observation date. Store signed minor units, currency, provider, connection identity and observation timestamp. The latest same-day observation replaces that day only; retries do not create duplicate observations or overwrite a newer observation. Application members can read their household; only cloud services write observations. The new collection brings the local model to thirteen open collections without altering or rebuilding existing collection schemas.

Current account totals use the latest reported balance exactly, regardless of transaction import progress or manual financial edits. Accounts without a report retain ledger-derived balances. Keep this single rule in the shared balance engine and use it for account lists, dashboard, goals, export, nightly snapshots and alerts. The independent Investment application remains unchanged.

Cloud sync records current balances for all mapped accounts from its existing accounts response, even while transaction history is incomplete. It no longer writes synthetic bank reconciliation transactions. After saving each authoritative observation, retire only the exact legacy reconciliation record belonging to that account and link, with ownership/marker/revision checks. Provider failures retain the last successful observation and never invent a daily report. The hourly dispatcher and daily provider cadence are unchanged.

For historical dates with a provider report, show that value. Fill other dates from the nearest preceding report plus signed posted transactions since that date; before the first report, subtract subsequent signed transactions from that first report. If no report exists, use the opening balance and transactions. Exclude pending transactions and legacy bank reconciliation adjustments, while retaining transfers, hidden real transactions and manual value updates. Label inferred dates as Estimated and reported dates with provider and observation time. Nightly aggregates are not misrepresented as provider reports. Replication remains asynchronous and shared across tabs.
