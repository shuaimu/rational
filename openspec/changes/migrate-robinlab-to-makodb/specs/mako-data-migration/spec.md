## Purpose

Move RobinLab's existing data into MakoDB through a verifiable migration that preserves accepted changes and permits lossless rollback.

## ADDED Requirements

### Requirement: Verify the authoritative source before import
Migration tooling SHALL inventory the configured SQLite source and identify invalid references, conflicting identifiers, and legitimate repeated trade occurrences. It SHALL record SQLite as the authoritative dataset and compare destination records with its frozen manifest. Unresolved financially meaningful integrity discrepancies MUST prevent cutover. Supabase is obsolete by user confirmation and SHALL NOT be required for reconciliation or contribute migration data.

#### Scenario: Obsolete cloud source unavailable
- **WHEN** the former Supabase project cannot be reached
- **THEN** migration proceeds using the verified SQLite source without requiring a Supabase export

#### Scenario: Source reference is missing
- **WHEN** a SQLite transaction references an absent account or ticker
- **THEN** the migration report identifies the integrity discrepancy and prevents cutover until it is resolved

### Requirement: Repeatable dry run and scoped destination
Migration SHALL support a no-write dry run, stable source/destination identifiers, record counts, normalized checksums, relationship validation, and resumable execution. It MUST target only the selected RobinLab environment within Rational, reject unknown occupied destination data, and preserve existing source stores.

#### Scenario: Resume interrupted import
- **WHEN** migration resumes with the same source manifest after a partial upload
- **THEN** already verified data is reused without duplicated records and completion yields the same dataset as an uninterrupted migration

#### Scenario: Wrong target
- **WHEN** configuration points at an unrelated populated Rational environment
- **THEN** preflight refuses the migration before any record mutation

### Requirement: Separate credential migration
Migration SHALL classify and transfer required integration credentials using server-only secret handling. General exports, checked-in artifacts, browser-visible collections, and reports MUST exclude secret values while recording whether required credential transfer is complete.

#### Scenario: Brokerage secret export
- **WHEN** a migration report and ordinary dataset export are generated
- **THEN** neither contains the SnapTrade user secret and cutover readiness records its separate secure-transfer status

### Requirement: Verified cutover
Cutover SHALL pause every old writer, preserve consistent source backups, verify destination record/reference integrity and portfolio results, then switch backend persistence and browser replication coherently. Readiness MUST include representative option actions, imports, offline behavior, authorization failures, and scheduled-job recovery.

#### Scenario: Portfolio mismatch
- **WHEN** destination positions or performance differ beyond the documented tolerance from the frozen reconciled source
- **THEN** cutover is refused and the mismatch is included in the validation report

#### Scenario: Legacy writers still active
- **WHEN** a scheduled legacy importer is still able to mutate the source
- **THEN** cutover is not declared ready until that writer is paused and the final source snapshot is validated

### Requirement: Rollback preserves accepted cloud writes
Rollback SHALL distinguish a destination with no post-cutover mutations from one with accepted cloud changes. In the latter case it MUST freeze cloud writes, export and reconcile committed changes into a restored legacy dataset, and verify that dataset before switching back.

#### Scenario: Rollback after a new trade
- **WHEN** a trade was accepted in MakoDB after cutover and rollback is requested
- **THEN** the restored dataset includes that trade and all other accepted changes before legacy writes resume
