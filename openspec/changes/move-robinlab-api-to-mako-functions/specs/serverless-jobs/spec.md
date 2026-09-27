## Purpose

Keep long-running imports and maintenance reliable across short-lived cloud function invocations without requiring a browser session, laptop timer or external permanent worker.

## ADDED Requirements

### Requirement: Durable bounded execution
Work that cannot finish within a qualified invocation budget SHALL become a durable job with a stable operation identity, integrity-bound input, observable state and resumable progress. Every invocation MUST persist continuation or completion before returning and MUST NOT depend on unbounded background work after its response. Only authorized principals SHALL submit or view a job.

#### Scenario: Worker is terminated mid-job
- **WHEN** a function stops after some work has been checkpointed
- **THEN** a later invocation resumes from durable state without duplicating accepted financial changes or requiring the client to remain open

#### Scenario: Caller submits a changed payload under the same identity
- **WHEN** a job submission reuses an operation identity with a different input digest
- **THEN** the service rejects it rather than changing the existing job's meaning

### Requirement: Distributed coordination and safe retry
Job claims, checkpoints and shared provider budgets MUST use durable conditional coordination. An expired claimant MUST NOT overwrite newer progress. Financial publication MUST remain protected by durable command replay and conditional head publication independent of worker affinity or leases. External calls with ambiguous non-idempotent outcomes MUST be reconciled before retry or reported as requiring attention.

#### Scenario: Expired claimant returns late
- **WHEN** a new invocation has acquired a job after the prior claim expired
- **THEN** the prior invocation cannot replace the new claim's checkpoints or produce duplicate financial publication

#### Scenario: Registration response is lost
- **WHEN** a provider may have accepted a registration and its response is unavailable
- **THEN** the job uses supported reconciliation or stops with an actionable state instead of blindly creating another registration

### Requirement: Cloud scheduling operates without local processes
Mako Cloud scheduling SHALL admit one logical automatic SnapTrade import per configured hourly period and continue unfinished due work while all local API processes and browsers are stopped. Overlapping ticks, retries and manual triggers MUST NOT create duplicate scheduled imports. Only one automatic importer SHALL be active after cutover.

#### Scenario: Laptop is asleep at the due time
- **WHEN** a scheduled period arrives with the laptop API and browser unavailable
- **THEN** the hosted scheduler admits and processes the due job and records its outcome in cloud state

#### Scenario: Schedule delivery is repeated
- **WHEN** the same hourly period is delivered more than once or overlaps a running import
- **THEN** all deliveries converge on the same logical scheduled operation without duplicate transactions

### Requirement: Scheduled execution is independently authenticated
The job worker MUST reject public requests that lack qualified scheduler authority or an approved protected run credential. Publicly supplied schedule-identifying headers alone MUST NOT grant execution rights. Scheduling configuration and run history MUST NOT expose reusable credentials to unauthorized callers.

#### Scenario: Public caller spoofs scheduler headers
- **WHEN** an unauthenticated request supplies schedule/run identifiers
- **THEN** it cannot start privileged work or access private job data

### Requirement: Job progress distinguishes acceptance from completion
The frontend SHALL display queued/running/retry/failed/cancelled/needs-attention states and recover the same submitted operation after reload. It MUST report financial success only after a committed result is available and its version has reached the verified local replica. Cancellation MUST NOT be presented as undoing a committed operation.

#### Scenario: Import is accepted but unfinished
- **WHEN** job admission returns before import completion
- **THEN** the UI displays progress rather than a success result and can resume observing it after reload

#### Scenario: Completion races cancellation
- **WHEN** the portfolio command commits before cancellation takes effect
- **THEN** the service reports the committed result/version and the client does not claim the data was undone

### Requirement: Private recovery data has a bounded lifecycle
Uploaded chunks, captured provider input and recovery records SHALL remain private and retained long enough for supported recovery/replay. Cleanup MUST distinguish referenced or active data from disposable terminal-job artifacts and MUST NOT delete the portfolio's live manifest or command history.

#### Scenario: Maintenance cleans expired upload data
- **WHEN** an abandoned upload exceeds its documented retention and has no active or committed reference
- **THEN** it can be removed without affecting live jobs, accepted commands or portfolio reads
