## Purpose

Move RobinLab's compute into Mako Cloud functions through a verified, reversible cutover that preserves existing data and proves the application no longer depends on a local backend.

## ADDED Requirements

### Requirement: Qualification uses the actual deployed runtime
Cutover MUST require hosted evidence for shared-domain execution, representative and maximum-size supported imports, cold full-portfolio access, function budgets, allowed egress, scheduling authority, CORS and secret isolation. Local tests and source-level platform specifications alone SHALL NOT establish hosted readiness.

#### Scenario: Hosted capability is unavailable
- **WHEN** a required feature fails in the deployed runtime despite being documented
- **THEN** cutover remains disabled, the existing application remains usable, and the failure is recorded with a concrete remediation or upstream issue

### Requirement: Frontend routing has no implicit local backend
The normal frontend SHALL send API operations to the configured function endpoint and retain authenticated Mako replication for local reads. It MUST preserve auth renewal, idempotency and version catch-up across permitted browser origins. Stopping port 3000 MUST NOT break normal application operation, and it MUST NOT silently fall back to a local service.

#### Scenario: Clean browser uses only cloud APIs
- **WHEN** a fresh browser signs in with no local backend listener
- **THEN** it can read the portfolio, perform a reversible validated mutation and observe the committed version through replication

#### Scenario: User reloads offline
- **WHEN** an already-authorized browser reopens without network connectivity
- **THEN** it displays its last verified portfolio according to the existing offline policy and sends no misleading successful cloud writes

### Requirement: Compute cutover preserves the authoritative dataset
Cutover SHALL reuse the current Mako environment and portfolio without reinitialization or restoring old source snapshots. It MUST quiesce or reconcile old writers, preserve in-flight operation identities and verify the current dataset before switching mutation traffic. The local scheduler MUST stop before cloud scheduling is enabled.

#### Scenario: Accepted write exists at cutover
- **WHEN** the old API accepted a command immediately before writers are quiesced
- **THEN** its data and replay result remain available through the new function API

#### Scenario: New scheduler is activated
- **WHEN** hosted API and browser readiness checks pass
- **THEN** exactly one cloud automatic importer is enabled and the local API/timer remains stopped

### Requirement: Final acceptance proves independence and compatibility
Completion SHALL require functional checks for all supported route families, native/hosted financial parity, repeated imports, interrupted jobs, lost responses, concurrent writes, auth failures, fresh-browser login, reload/offline behavior and a hosted scheduled run. Evidence MUST include retained screenshots and reports, with no local API or test worker assisting final operation.

#### Scenario: Final smoke test runs
- **WHEN** local backend and temporary test workers are stopped
- **THEN** the UI, API mutations, replication and hosted scheduled work pass their documented checks and disposable synthetic records are reconciled

### Requirement: Rollback preserves accepted cloud writes
The runbook SHALL describe versioned function rollback and restoration of the retained Rust compute against the current cloud dataset. Before compute rollback, cloud job admission/scheduling MUST be paused and in-flight jobs reconciled. A pre-cutover data snapshot MUST NOT overwrite later accepted writes.

#### Scenario: Function version must be rolled back
- **WHEN** a deployed compute version fails after accepting portfolio writes
- **THEN** the operator can restore a qualified serving version while preserving those writes and preventing two active schedulers
