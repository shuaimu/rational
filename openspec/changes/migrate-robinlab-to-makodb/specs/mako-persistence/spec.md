## Purpose

Provide authoritative MakoDB persistence for RobinLab while preserving portfolio correctness, private integration state, and existing application operations.

## ADDED Requirements

### Requirement: One authoritative cloud store
After cutover, the system SHALL use the configured RobinLab environment in the existing Rational project for all durable application writes and subsequent reads. It MUST NOT silently fall back to SQLite or Supabase when cloud access fails, and MUST leave other Rational environments intact.

#### Scenario: Restart without legacy stores
- **WHEN** the migrated service restarts with SQLite and Supabase unavailable
- **THEN** it restores committed portfolio and integration state from MakoDB and can service authenticated requests

#### Scenario: Cloud outage
- **WHEN** a write cannot reach MakoDB
- **THEN** the operation reports an unavailable or recoverable pending outcome without accepting a divergent legacy-store write

### Requirement: Complete portfolio operations
The system SHALL expose each option roll, close, expiry, assignment, and import publication as a complete committed operation. Readers MUST NOT observe only some of its related financial changes. Concurrent operations MUST preserve uniqueness, references, and committed updates.

#### Scenario: Interrupted option roll
- **WHEN** processing fails after preparing a closing leg but before publishing the complete roll
- **THEN** all readers continue to see the previous complete portfolio and a retry can safely finish the operation

#### Scenario: Concurrent edits
- **WHEN** two writers prepare changes against the same portfolio version
- **THEN** a stale writer recomputes or reports a conflict and does not overwrite the other committed result

### Requirement: Durable retry identity
Mutations SHALL use durable operation identities that survive retries and service restarts. A retry of a committed request SHALL return its original result without additional records; reusing its identity with different input MUST fail. Imports SHALL preserve legitimate repeated trade occurrences while preventing duplicates from overlapping reimports.

#### Scenario: Lost successful response
- **WHEN** a roll commits but its response is lost and the caller retries after restart
- **THEN** the same resulting transaction identifiers are returned and no extra roll legs are created

#### Scenario: Repeated trade occurrences
- **WHEN** a source contains two identical legitimate trades and the same source is imported twice
- **THEN** the resulting ledger contains two occurrences rather than one or four

### Requirement: Preserve data and calculation behavior
The system SHALL preserve business identifiers, references, transaction fields, numerical precision, dates, and provenance. Accounts, positions, analytics, option actions, Excel import, SnapTrade, price lookup, and cache administration SHALL retain their existing domain behavior through relative `/api` endpoints, subject to the new authentication requirement.

#### Scenario: Equivalent portfolio input
- **WHEN** legacy and migrated calculations receive the same reconciled transactions, splits, and price observations
- **THEN** position quantities and statuses match exactly and monetary/performance results match the documented numerical tolerance

### Requirement: Protect financial data and integration credentials
The system SHALL authorize the configured application owner for protected app operations and only explicitly provisioned worker identities for privileged storage operations. Developer-console sessions, email matches, public project keys, and unrelated application users MUST NOT grant access. Brokerage secrets, worker credentials, and privileged keys MUST remain inaccessible through browser bundles, replication, logs, and unprivileged document APIs.

#### Scenario: Unrelated Rational user
- **WHEN** a user from another environment or an unapproved RobinLab user requests portfolio data or a write
- **THEN** the request is denied without returning portfolio records or causing a mutation

#### Scenario: Browser attempts privileged persistence
- **WHEN** an owner browser attempts a direct financial-document write or worker-only gateway call
- **THEN** the request is denied and the owner must use the domain-validated application operation

### Requirement: Durable background integration state
Scheduled imports SHALL retain deduplication state, balances, snapshots, and committed import watermarks across restarts. A watermark MUST NOT advance past uncommitted financial records, and unavailable or revoked worker authentication MUST pause work without losing its resume state.

#### Scenario: Restart during SnapTrade sync
- **WHEN** the process restarts during an import before its publication completes
- **THEN** the next run resumes or reimports from the last committed watermark without skipping or double-counting activities
