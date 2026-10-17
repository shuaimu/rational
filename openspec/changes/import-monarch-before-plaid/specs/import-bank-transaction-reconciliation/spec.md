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

### Requirement: Ambiguous overlap requires review
The system MUST expose ambiguous potential matches for a user to merge or keep separate. It MUST NOT silently choose a candidate, discard the bank record or book a potential duplicate as ordinary spending while review is unresolved.

#### Scenario: Several imported rows could match one bank record
- **WHEN** a bank transaction has several plausible matches or insufficient description evidence
- **THEN** Rational stages it for review and shows that synchronization needs review until the user resolves the ambiguity

### Requirement: Do not drop history through a blanket cutoff
The system MUST NOT discard every bank transaction on or before the latest CSV transaction date. Matching and import decisions SHALL accommodate future-dated manual entries, delayed posting and historical gaps.

#### Scenario: CSV has a future-dated manual transaction
- **WHEN** a future-dated CSV row exists and Plaid supplies an unmatched purchase from the current week
- **THEN** the future row does not suppress the bank purchase

### Requirement: Reconcile balances independently of duplicate matching
The system SHALL verify balances separately from income and spending. Reconciliation entries MUST be distinguishable from ordinary transactions and MUST NOT be used to conceal unresolved duplicate history.

#### Scenario: Current bank balance matches while duplicates remain unresolved
- **WHEN** balance reconciliation succeeds but transaction overlap still requires review
- **THEN** the UI continues to show the unresolved review count and does not claim the history is fully verified
