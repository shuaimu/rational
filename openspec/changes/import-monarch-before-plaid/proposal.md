## Why

Rational must preserve a user's Monarch transaction history before switching to ongoing bank synchronization. Manually copying account balances does not migrate that history, and importing CSV rows followed by an unrestricted Plaid import would duplicate overlapping transactions.

## What Changes

- Add a dedicated Monarch CSV import flow with a preview grouped by source account, explicit account creation or matching, and validation before writes.
- Preserve exported transaction IDs, dates, signed amounts, merchants, original statements, categories, notes, tags, owner labels and review status. Explain fields absent from the export rather than inventing them.
- Accept an optional Monarch balance CSV to establish accurate balances without adding transaction history on top of a current-balance snapshot.
- Run accepted imports as durable, bounded Mako Cloud jobs, with progress, retries and cancellation available after the browser closes.
- Keep existing-account Plaid linking and make it discoverable from an imported account. Preserve account identity and imported metadata.
- Reconcile overlapping CSV and Plaid transactions automatically and one-to-one, preserving duplicate occurrences and annotations; unmatched bank records enter the ledger normally.
- Store daily reported account balances separately from transactions; use the latest source balance for current totals and transaction-derived estimates for historical gaps.
- Preserve the generic single-account CSV importer and the independent Rational Investment ledger.

## Capabilities

### New Capabilities
- `monarch-csv-import`: Multi-account preview, metadata preservation, balance reconciliation, and resumable cloud import.
- `plaid-existing-account-linking`: Attach authorized bank accounts to existing household accounts with ownership, type and currency checks.
- `import-bank-transaction-reconciliation`: Idempotent CSV re-import and explicit reconciliation of later bank history.

### Modified Capabilities
None. The planning home has no existing main specifications for these household features.

## Impact

- Household frontend: `src/ui/import.tsx`, `src/ui/account.tsx`, `src/ui/connections.tsx`, CSV selectors, API clients and transaction review.
- Cloud: bounded import admission/upload/worker/status routes, durable private job state, imported-row provenance and Plaid transaction identity resolution.
- Mako schemas, indexes, service scopes, deployment and compatibility checks; no sensitive exports in Git.
- Validation: CSV fixtures, retry/failure and household-isolation tests, overlap reconciliation tests, large-import checks and real Chrome verification.
- Operational reset: delete only the previously recorded manual account IDs as separately requested. This cleanup is not a general household erase operation.
