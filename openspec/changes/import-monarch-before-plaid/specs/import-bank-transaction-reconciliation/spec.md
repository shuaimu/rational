## Purpose

Prevent repeated CSV imports and overlapping bank feeds from distorting household history, while preserving legitimate identical transactions and user annotations.

## ADDED Requirements

### Requirement: Re-import is idempotent without collapsing legitimate rows
The system SHALL use exported Monarch transaction IDs when available to recognize repeated rows across files, and retain the multiplicity of legitimate identical transactions with different source IDs. It MUST NOT overwrite user-edited annotations when a file is uploaded again. Older files without source IDs SHALL use explicit occurrence-aware matching; uncertain changes in an overlapping export MUST be surfaced for review.

#### Scenario: Same file is imported twice
- **WHEN** the same CSV and account mapping are accepted again
- **THEN** no additional accounts or transactions are booked and the result reports the existing import

#### Scenario: A later export contains the same transaction ID
- **WHEN** a later file includes an already imported Monarch ID with edited notes
- **THEN** no second transaction is created and any conflict with Rational edits is surfaced rather than silently overwritten

#### Scenario: Two legitimate transactions share financial fields
- **WHEN** a file contains two transactions with identical dates, amounts and descriptions
- **THEN** both occurrences are preserved, and replay does not create third or fourth occurrences

### Requirement: Reconcile overlapping bank history one-to-one
The system SHALL resolve a bank transaction to at most one imported transaction in the same account using financial fields and source-description evidence. A confirmed match MUST preserve imported category, notes, tags and user edits while recording the bank identity for later changes and removals. Retries MUST NOT create a second booked entry.

#### Scenario: Bank redelivers an imported purchase
- **WHEN** a posted bank transaction uniquely matches an imported purchase under the documented matching criteria
- **THEN** it is linked to that existing transaction, contributes to balances and cash flow once, and preserves imported annotations

#### Scenario: Matching is interrupted
- **WHEN** a worker stops between recording an identity match and applying the ledger update
- **THEN** retry completes the same match without creating a duplicate or losing the imported row

### Requirement: Bank overlap reconciliation is automatic
The system SHALL reconcile posted bank records without a manual merge queue. Matching SHALL require the same account, currency and signed amount, a posting-date difference of at most three days, and matching original-description or merchant evidence. Matches SHALL be ranked by source-description evidence, merchant evidence, date proximity and stable transaction identity. Claimed candidates MUST NOT be reused by another bank identity. A record without qualifying evidence SHALL be added separately.

#### Scenario: Several identical imported purchases match a bank feed
- **WHEN** several imported purchases share the same financial fields and source description
- **THEN** bank records are attached to distinct unclaimed occurrences in a deterministic order, and excess bank occurrences are added separately

#### Scenario: A prior deployment left pending reviews
- **WHEN** the cloud sync encounters a staged bank review whose provider cursor already advanced
- **THEN** it reconciles that saved identity automatically in a bounded phase without requiring provider redelivery or user action

#### Scenario: A user edited financial fields or deleted a matched transaction
- **WHEN** a later bank correction or removal conflicts with those edits
- **THEN** Rational preserves the local edit, split totals or deletion, records the newest provider fields privately, and completes synchronization without a review queue

### Requirement: Do not drop history through a blanket cutoff
The system MUST NOT discard every bank transaction on or before the latest CSV transaction date. Matching and import decisions SHALL accommodate future-dated manual entries, delayed posting and historical gaps.

#### Scenario: CSV has a future-dated manual transaction
- **WHEN** a future-dated CSV row exists and Plaid supplies an unmatched purchase from the current week
- **THEN** the future row does not suppress the bank purchase

### Requirement: Reported balances are independent of transactions
The system SHALL retain one daily provider balance observation per account and UTC date, with currency, provider and observation timestamp. Current account balances SHALL use the latest reported amount exactly. Sync MUST NOT create reconciliation transactions to force a ledger total to match a report. It SHALL safely retire its own legacy reconciliation adjustments after saving replacement observations.

#### Scenario: History is incomplete or later edited
- **WHEN** a valid provider balance exists while history is still importing or a transaction is edited
- **THEN** current account totals and nightly balances use the provider amount without adding transaction sums to it

#### Scenario: A provider observation is retried
- **WHEN** synchronization repeats on the same day or resumes after a partial failure
- **THEN** there is one observation for that account/date, newer observations are preserved, and legacy cleanup can resume independently

#### Scenario: A daily refresh fails
- **WHEN** the provider cannot supply a valid balance
- **THEN** the last successful balance remains available with its observation time and no new reported daily point is fabricated

### Requirement: Estimate missing historical balances
For dates without source reports, account history SHALL estimate signed balances from a known reported balance and posted transactions, or from the opening balance when no report exists. Source-reported and estimated values SHALL be distinguishable. Pending transactions and synthetic bank reconciliation adjustments MUST NOT affect estimates. Transfers and hidden real transactions SHALL affect estimates.

#### Scenario: Imported transactions predate bank linking
- **WHEN** imported transactions exist before the first reported balance
- **THEN** earlier daily balances are estimated by subtracting intervening signed transactions from the first report and labeled Estimated

#### Scenario: Daily reports have a gap
- **WHEN** no provider observation exists for a date between two reports
- **THEN** the missing date is estimated from the preceding report and intervening transactions, while each reported date retains its exact source value

#### Scenario: Household isolation
- **WHEN** another household or a different currency has an observation
- **THEN** it cannot be read by an unauthorized member or used in this account's balance
