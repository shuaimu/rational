## Purpose

Bring Monarch transaction history into a household with explicit account mapping, faithful metadata and verifiable balances before bank synchronization begins.

## ADDED Requirements

### Requirement: Preview multiple accounts before writing
The system SHALL recognize Monarch's documented transaction CSV columns and display source accounts, date ranges, row counts, validation errors and proposed destinations before writing portfolio data. The user MUST explicitly accept account destinations, types and currencies that the file cannot establish.

#### Scenario: New household imports a multi-account export
- **WHEN** an owner uploads a valid Monarch CSV containing several account names
- **THEN** the preview offers to create or map each account, and confirmation creates only selected accounts and imports their accepted rows

#### Scenario: Account identity is ambiguous
- **WHEN** the same source name can identify multiple accounts, or required type or currency information is unknown
- **THEN** the import requires explicit resolution and does not silently combine accounts or invent missing metadata

### Requirement: Preserve exported transaction information
The system SHALL preserve source transaction IDs as strings, valid signed amounts, dates, merchants, original statements, categories, notes, tags, owner labels and exported review status. It MUST support quoted fields, commas, newlines, Unicode, UTF-8 BOM and legitimate repeated transactions. Invalid rows MUST be reported with their line numbers and reasons. Data absent from the CSV MUST be identified as unavailable. Owner labels MUST NOT create membership or access rights.

#### Scenario: Export contains personal annotations
- **WHEN** a transaction contains a renamed merchant, an original bank statement, notes and multiple tags
- **THEN** each exported value remains accessible after import and rule processing does not silently replace it

#### Scenario: Export includes long IDs and review status
- **WHEN** a row contains a transaction ID beyond the safe JavaScript integer range and an explicit review status
- **THEN** the full ID remains an exact string and review status is preserved without treating blank status as reviewed

#### Scenario: Export contains transfers
- **WHEN** exported categories are confirmed as transfers or credit-card payments
- **THEN** the imported monetary entries remain on their source accounts and do not inflate income or spending

### Requirement: Reconcile transaction history with balance evidence
The system SHALL accept an optional Monarch balance CSV and reconcile each account's transaction-derived balance against a selected source balance date. It MUST include the effects of transactions after that date, preserve liability signs and distinguish unknown balances from zero. It MUST NOT add historical transaction totals on top of an already-current balance.

#### Scenario: Current balance accompanies historical transactions
- **WHEN** the export supplies a balance and historical transactions for an account
- **THEN** Rational computes the opening balance needed to reach the source balance on that date and reports any reconciliation exception before completion

#### Scenario: No balance evidence exists
- **WHEN** the transaction CSV does not establish an account's opening or current balance
- **THEN** the preview labels that balance as unverified and requires an explicit opening-balance choice rather than presenting a guessed total as verified

### Requirement: Imports survive browser closure and worker interruption
Once a validated upload is sealed and accepted, the system SHALL process it in bounded cloud phases with durable progress. Replaying uploads or committed phases MUST NOT duplicate accounts, taxonomy or transactions. The user SHALL be able to inspect progress, retry a failure and cancel future processing without deleting accepted records.

#### Scenario: Browser closes during an accepted import
- **WHEN** the user closes Rational after upload and job admission
- **THEN** cloud processing remains resumable and reopening the app shows accepted, pending and failed counts

#### Scenario: Worker fails after writing rows
- **WHEN** a phase writes some rows and fails before recording completion
- **THEN** retry retains those rows exactly once and progresses from durable evidence

### Requirement: Household authorization and ledger isolation
Only an owner or editor of the destination household SHALL admit imports or change their mappings. Raw source files and staging data MUST remain private, and imported financial data MUST NOT enter the independent Investment ledger.

#### Scenario: Request targets another household
- **WHEN** a caller without write membership supplies another household's import or account identifier
- **THEN** the operation is rejected without reading private source data or mutating that household
