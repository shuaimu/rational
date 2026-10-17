## 1. CSV contract and preview

- [x] 1.1 Add synthetic fixtures for documented and current Monarch columns, preserving string IDs, review status, owner labels, Unicode, quotes, newlines, repeated rows and invalid values; test explicit tag-separator choices while retaining unknown encodings intact without modifying the user's source data.
- [x] 1.2 Implement a shared strict transaction and balance CSV parser with line-specific errors, explicit omissions and no silent value truncation.
- [x] 1.3 Build a per-account import manifest with explicit destination/type/currency choices, source-name collision checks, category-kind mappings and optional balance evidence.
- [x] 1.4 Add the Monarch preview mode alongside the generic CSV importer, showing counts, date ranges, metadata coverage, duplicate candidates and balance effects before admission.

## 2. Durable cloud import

- [x] 2.1 Define private job/chunk/provenance and provider-identity storage schemas, indexes and scoped service permissions; add required public document fields with compatible local migrations.
- [x] 2.2 Implement authenticated start, chunk upload, seal, status and cancel routes with immutable request identities, byte/row limits, checksums and per-operation household authorization.
- [x] 2.3 Implement bounded cloud phases for validation, account/taxonomy creation and transaction writes with deterministic identities, expected revisions and interruption-safe progress.
- [x] 2.4 Implement source-ID re-import handling and occurrence-aware legacy fallback; preserve legitimate duplicates and user edits while surfacing conflicts.
- [x] 2.5 Reconcile opening balances from selected source dates and signed history, keep incomplete accounts visibly pending, and block bank linking until their import is complete.
- [x] 2.6 Wire pending imports into the existing hourly dispatcher without adding a local worker or minute schedule; expose a manual bounded Continue action and durable progress.

## 3. Existing-account Plaid linking and overlap review

- [x] 3.1 Add a discoverable Link bank action on existing account detail and preserve explicit compatible account selection after Plaid authorization, including reload recovery.
- [x] 3.2 Implement durable provider-identity lookup and one-to-one matching to imported transactions, with exact auto-match criteria and optimistic conflict checks.
- [x] 3.3 Add staged overlap review for date-window, merchant-only and multi-candidate matches; support Merge with existing and Keep separate without double-booking pending review.
- [x] 3.4 Apply provider corrections/removals to matched identities while preserving imported provenance and annotations; surface conflicts with later manual edits.
- [x] 3.5 Keep provider-history readiness, overlap review, balance reconciliation and daily sync completion distinct in status displays; do not use a blanket latest-import-date cutoff.

## 4. Validation and release

- [x] 4.1 Test authorization isolation, malformed uploads, checksums, changed manifests, interrupted writes, revision conflicts, cancellation and same-file replays.
- [x] 4.2 Test exact source-ID re-import, long IDs, identical legitimate purchases, missing IDs, transfers, liability signs, transactions after a balance date, future-dated rows and preservation of notes/tags/review status.
- [x] 4.3 Test imported-to-bank matching, ambiguous overlap, retries between identity and ledger writes, provider corrections/removals and unchanged account IDs.
- [ ] 4.4 Exercise a synthetic import exceeding twenty thousand transactions with bounded requests, durable checkpoints and completion after closing the browser.
- [x] 4.5 Run affected typechecks, builds and focused tests, plus required repository checks before PR; perform Chrome smoke checks for import preview/progress and existing-account linking.
- [x] 4.6 Deploy compatible schemas/functions and publish the updated frontend; verify old clients fail safely and generic CSV import still works.
- [ ] 4.7 Preview the private user exports, resolve account-name/balance ambiguities, import accepted data and verify per-account counts and balances against the source.
- [ ] 4.8 After history verification, hand off the first bank's sign-in/consent, link its returned accounts to the imported accounts and verify duplicate handling before continuing remaining institutions.

### Validation evidence (2026-10-16)

- 20,001-row synthetic engine regression passed with fresh worker instances between bounded phases. A three-row live cloud import completed with its browser page closed; a missing transaction account index was corrected and retry reconciled the expected balance. A live 20,001-row cloud import has not been run, so 4.4 remains open.
- Chrome verified preview, duplicate purchases, notes/review flags, balance evidence, cloud progress, existing-account Link bank routing, and the unchanged generic CSV importer. Synthetic records were separately identified for cleanup.
- Root typecheck and household build, 261 unit tests (serial run), strict cloud function typecheck, Investment lint/build/Rust/function tests, and OpenSpec validation passed. The parallel unit run exposes a pre-existing timing-sensitive bulk-input fixture; the serial full suite passes.
- Real export admission awaits the user's resolution of duplicate Monarch Buy/Sell category names. Bank consent remains deferred until history verification. No real CSV transactions were admitted.

- Release: Rational PR3 merged and Pages run 38998416881 succeeded. Published Monarch UI verified in Chrome. Function v14 is healthy. All 18 synthetic cloud records were removed with revision checks; local and published Personal accounts are empty. The real local preview has 50 verified account mappings, balance evidence and source-derived category kinds; Buy/Sell and final admission remain pending.
