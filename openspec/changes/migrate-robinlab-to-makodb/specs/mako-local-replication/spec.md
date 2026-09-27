## Purpose

Keep RobinLab reads available locally while securely synchronizing complete committed portfolio versions from the selected MakoDB environment.

## ADDED Requirements

### Requirement: Application sign-in and cache isolation
Protected portfolio views SHALL require an established session for the configured RobinLab owner. Cached data SHALL be isolated by cloud endpoint, project, environment, and application identity. The system MUST NOT treat the developer-console login as an application session or merge old Supabase seed data into the cloud dataset.

#### Scenario: First launch
- **WHEN** a fresh browser opens RobinLab without an application session
- **THEN** it shows the sign-in boundary and does not display protected cached or seed portfolio data

#### Scenario: Switch environment or user
- **WHEN** a different environment or application identity is selected
- **THEN** data from the previous scope cannot appear in the new scope

### Requirement: Complete replicated views
The application SHALL query a complete local committed portfolio version. Out-of-order delivery of a version announcement, its referenced records, or deletions MUST NOT expose a mixture of versions. After a successful backend mutation, the UI SHALL distinguish synchronization in progress from a view that contains the committed result.

#### Scenario: Commit arrives before records
- **WHEN** replication announces a new commit before all required portfolio data arrives
- **THEN** the previous complete view remains visible until the new view can be published completely

#### Scenario: Successful write catches up
- **WHEN** an option assignment succeeds and the UI finishes refreshing
- **THEN** both the option status change and resulting stock records are visible together

### Requirement: Offline reads and reconnect
An established owner with a complete cache SHALL retain local portfolio reads during transient network failures, including offline reload, with a visible synchronization status. Writes requiring backend validation MUST NOT be reported as committed while disconnected. Reconnection SHALL resume synchronization without duplicating data.

#### Scenario: Offline restart
- **WHEN** an owner with previously synchronized data reloads while the network is unavailable
- **THEN** the cached portfolio is readable with an offline indicator and no destructive sign-out occurs solely because token renewal cannot reach the service

### Requirement: Revocation and sign-out clear protected state
Explicit sign-out, definitive session revocation, and authorization changes SHALL block protected rendering and stop replication before clearing protected local data and checkpoints. Resumption SHALL use the currently authorized identity and a valid fresh replication generation.

#### Scenario: Authorization revoked
- **WHEN** the server reports that the current owner session no longer has access
- **THEN** protected views become inaccessible and stale local data cannot be exposed by retrying replication or reloading

### Requirement: Explicit replication recovery
The system SHALL surface schema incompatibility, expired checkpoints, permission failures, and throttling as distinct actionable states. It MUST stop terminal retry loops, honor retry delays, and complete any required reset before exposing replacement data.

#### Scenario: Expired checkpoint
- **WHEN** the server rejects a retained checkpoint as expired
- **THEN** the client resets the affected replication state, fetches a complete authorized dataset, and resumes without combining stale and new generations
