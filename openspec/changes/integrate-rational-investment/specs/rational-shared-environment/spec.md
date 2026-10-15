## Purpose

Consolidate Rational and investment services into one Mako environment while preserving financial state, authorization boundaries, accepted operations, and recoverable cutover.

## ADDED Requirements

### Requirement: One environment with preserved access boundaries
Both applications SHALL target Rational's existing configured environment after cutover. Investment access SHALL remain restricted to the explicitly mapped destination portfolio owner by default, independently of Rational signup or household membership. Browser identities MUST NOT gain access to provider credentials or private worker state. Existing Rational household permissions MUST remain intact.

#### Scenario: Authorized destination owner
- **WHEN** the verified destination owner requests investment data or submits an investment operation
- **THEN** the destination authorizes the request according to the investment API and document policies

#### Scenario: Other Rational user
- **WHEN** another Rational user, including an owner household's member without investment authorization, attempts direct investment replication or API access
- **THEN** the request is denied without exposing the investment ledger or private provider data

#### Scenario: Source credential after cutover
- **WHEN** a client presents a source-environment application session to the destination investment services
- **THEN** the destination refuses the session instead of treating a matching email as authorization

### Requirement: Preserve both applications' existing state
The migration SHALL preserve Rational's existing collections and policy behavior and all investment ledger/history, reachable portfolio content, counters, provider identities/mappings/watermarks, retained private state, cache state, command receipts, jobs/results, and retained uploads needed for recovery. Provisioning MUST fail on incompatible resource collisions. Missing export/import data MUST be reported as a failure, never treated as an empty dataset.

#### Scenario: Verified migration
- **WHEN** a complete quiescent source snapshot is imported
- **THEN** destination logical contents, references, counters, and financial outputs reconcile to the source, with documented identity transformations and no migration-caused changes to Rational household records

#### Scenario: Interrupted transfer
- **WHEN** a transfer is interrupted and restarted
- **THEN** it resumes using verified checkpoints and stable identities without losing or duplicating records

#### Scenario: Incompatible destination collection
- **WHEN** an existing destination resource conflicts with the investment schema or authorization contract
- **THEN** migration stops with a reported conflict and leaves that resource unchanged

### Requirement: Durable operation continuity
Accepted investment commands SHALL retain their stable identities, outcomes, and retry semantics across the environment move. Incomplete operations MUST be drained or explicitly reconciled before cutover, and ambiguous provider side effects MUST NOT be blindly retried. Unaccepted browser-local requests MUST be distinguished from accepted source operations.

#### Scenario: Lost response before migration
- **WHEN** a source command committed but its caller lost the response, and the caller retries that command after cutover
- **THEN** the destination returns the preserved result without repeating the financial or provider operation

#### Scenario: Outstanding operation at cutover
- **WHEN** an import or provider operation has not reached a reconciled checkpoint
- **THEN** activation remains blocked until its state and side effects have been accounted for

### Requirement: One active investment writer environment
The cutover SHALL fence source mutation entry points and scheduled admission before the final source snapshot, and activate destination writers only after validation. Exactly one investment dispatcher SHALL admit periodic work after cutover. Existing Rational household schedules MUST retain their independent behavior.

#### Scenario: Old browser tab
- **WHEN** a pre-migration RobinLab tab attempts a source write after cutover
- **THEN** the source rejects the mutation and the user is directed to the new application rather than creating divergent data

#### Scenario: Resume within an already processed hour
- **WHEN** the destination dispatcher resumes in an hour whose investment sync command was already accepted by the source
- **THEN** imported command state prevents a duplicate operation

#### Scenario: No local processes
- **WHEN** all local API processes and migration helpers are stopped
- **THEN** hosted investment jobs continue making observable progress in the destination with no source investment dispatcher active

### Requirement: Rollback preserves new writes
Rollback SHALL preserve every accepted investment write. Before destination activation it SHALL leave the authoritative source intact. After destination writes begin, it MUST reconcile current destination state back to the rollback target before re-enabling source writers. An old snapshot MUST NOT overwrite newer accepted state.

#### Scenario: Staging validation failure
- **WHEN** destination validation fails before writes are enabled
- **THEN** the source can resume only after confirming destination writers remain inactive

#### Scenario: Rollback after destination write
- **WHEN** rollback is required after the destination accepts a transaction
- **THEN** that transaction and its retry receipt are preserved in the rollback target before source admission resumes

### Requirement: Daily automatic investment sync with hourly dispatch
The destination investment dispatcher SHALL run once per hour and admit at most one new automatic brokerage import and one automatic price refresh per UTC day. Automatic price refresh requested by the API SHALL share the dispatcher’s daily identity. Accepted historical jobs, checkpoints and manual command identities MUST be preserved. Daily admission does not guarantee completion within a day.

#### Scenario: Repeated automatic requests in one day
- **WHEN** hourly dispatcher ticks or automatic API quote requests occur within the same UTC day
- **THEN** they reuse the same respective daily job identities, including after completion or retries

#### Scenario: Next UTC day
- **WHEN** an automatic request occurs on the next UTC day
- **THEN** it admits that day’s job without rewriting previous jobs

#### Scenario: Existing pending work
- **WHEN** the schedule changes from every minute to every hour
- **THEN** accepted jobs retain their original identities and checkpoints and progress in bounded hourly phases without a local runtime
