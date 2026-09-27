## Purpose

Provide RobinLab's authenticated application operations through Mako Cloud functions while preserving financial correctness, private-data boundaries and durable write semantics.

## ADDED Requirements

### Requirement: Hosted owner-authenticated application API
The application SHALL provide all existing account, ticker, transaction, option-action, portfolio, analytics, price, import, SnapTrade and cache-administration route families through a deployed function endpoint. The endpoint MUST enforce the configured owner, project and environment and MUST NOT require a local API process or application-worker session file.

#### Scenario: Owner operates with local API stopped
- **WHEN** the owner submits a valid supported operation while no service is listening on local port 3000
- **THEN** the hosted endpoint processes it and returns its documented result or durable job identity

#### Scenario: Another principal attempts access
- **WHEN** an unauthenticated, foreign-owner or wrong-environment caller requests portfolio or administrative access
- **THEN** access is rejected without exposing private data or modifying any collection

### Requirement: Financial and import behavior remains equivalent
The hosted API SHALL preserve validated financial calculations, option roll/close/expire/assign behavior, ID allocation, transaction validation, nullable updates, split handling and import occurrence-count deduplication. Equivalent inputs, prices and dates MUST produce equivalent public/private portfolio contents and business results to the existing Rust backend within the existing explicitly defined financial tolerances.

#### Scenario: An option operation is migrated
- **WHEN** the hosted and retained Rust implementations process the same option lot and operation input
- **THEN** resulting transactions, statuses, identifiers and financial outputs agree

#### Scenario: Excel contains identical occurrences
- **WHEN** a workbook contains two valid identical source transactions and the same workbook is imported again
- **THEN** the first import preserves both occurrences and the later independent import adds none

### Requirement: Existing publication and command identities remain valid
The hosted API MUST preserve the current immutable manifest and command formats, public/private separation and conditional single-head publication. Accepted commands, including commands accepted before compute cutover, SHALL replay with their original result and committed version. Reusing an identity with a different operation or input MUST fail. Partial staging MUST NOT become a readable portfolio generation.

#### Scenario: Commit succeeds but the response is lost
- **WHEN** a client retries the same operation identity from a fresh function invocation
- **THEN** it receives the originally committed result/version without creating another transaction or advancing the head again

#### Scenario: Two writers update the same head
- **WHEN** two invocations prepare different valid operations against the same version
- **THEN** publication uses conditional conflict handling so neither silently overwrites the other's accepted changes

#### Scenario: A staged upload or mutation is interrupted
- **WHEN** execution stops before its complete final publication
- **THEN** existing clients retain the previous complete generation and a retry resumes or safely reuses immutable work

### Requirement: Hosted imports and provider integrations remain available
The system SHALL support Excel upload, SnapTrade connection/registration/linking, preview/apply imports, configured market-data providers and cache administration without a laptop filesystem, subprocess or Python runtime. It MUST accept supported workbooks up to the existing 50 MiB upload ceiling using bounded transfer when necessary, validate complete ordered input and enforce explicit expanded-content limits. Preview MUST leave the portfolio head unchanged.

#### Scenario: Workbook exceeds one request budget
- **WHEN** an authorized user uploads a supported workbook larger than the function's individual request limit
- **THEN** bounded transfer and integrity checks assemble one complete import input, with no publication from missing, altered or unfinalized chunks

#### Scenario: Broker import is previewed
- **WHEN** the owner requests a SnapTrade preview using the configured credentials
- **THEN** the system returns the preview outcome without committing transactions, balances, watermarks or a new portfolio head

#### Scenario: A provider requires delayed retry
- **WHEN** a provider returns a retryable failure or rate limit
- **THEN** the system records a bounded retry/status outcome and preserves committed portfolio data

### Requirement: Secret and external-network boundaries
Privileged service and provider credentials MUST remain available only to authorized function execution. Browser bundles, API/job responses and logs MUST NOT disclose those values. Outbound requests SHALL be restricted to declared provider hosts and approved platform endpoints, and concurrent invocations SHALL respect shared provider limits.

#### Scenario: Function attempts undeclared egress
- **WHEN** an invocation attempts to contact a destination outside its qualified allowlist
- **THEN** the request is rejected without exposing credentials or bypassing the runtime boundary

#### Scenario: Provider fails with sensitive response content
- **WHEN** a provider error contains credentials or private payload details
- **THEN** the user and operational logs receive sanitized diagnostics and a correlation identifier rather than the raw sensitive content
