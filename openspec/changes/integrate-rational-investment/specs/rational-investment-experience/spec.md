## Purpose

Provide Rational Investment as a dedicated investment application within Rational, with seamless navigation and authenticated access across both static entry points.

## ADDED Requirements

### Requirement: Dedicated investment homepage
Rational SHALL provide an **Investment** link to a dedicated homepage branded **Rational Investment**. That homepage SHALL retain investment navigation and provide a return link to Rational. Existing household holdings functionality and its saved links MUST remain reachable without rewriting household records.

#### Scenario: Navigate between applications
- **WHEN** a user follows Investment from Rational and then Back to Rational
- **THEN** the user reaches the investment dashboard and household application respectively, with the correct product branding and navigation

#### Scenario: Existing household holdings link
- **WHEN** a user opens an existing Rational household investments bookmark
- **THEN** the household holdings view remains available with its existing data and permissions

### Requirement: Shared authenticated session
Both entry points SHALL use the same destination-environment session. An authorized user MUST NOT need a second sign-in when navigating between them. Concurrent refresh, sign-out, identity changes, and definitive authorization revocation MUST be handled consistently across entry points and open tabs.

#### Scenario: Shared sign-in
- **WHEN** the portfolio owner signs into Rational and opens Rational Investment on the same origin
- **THEN** the investment application authenticates that existing session and displays only the portfolio authorized for it

#### Scenario: Concurrent session refresh
- **WHEN** both entry points need to refresh a rotating session at the same time
- **THEN** they converge on the valid renewed session without revoking one another through stale refresh attempts

#### Scenario: Cross-tab sign-out
- **WHEN** the user signs out from either application
- **THEN** both applications stop protected operations, remove accessible protected cached state, and require sign-in before displaying it again

#### Scenario: Temporary network outage
- **WHEN** a previously authorized user revisits an entry point offline and no definitive revocation has been received
- **THEN** its permitted local data remains available with offline status and protected writes follow the existing durable recovery behavior

### Requirement: Preserve investment behavior
Rational Investment SHALL preserve existing accounts, trades, options actions, positions, performance/analytics, workbook imports, SnapTrade flows, durable job recovery, and cache administration. Renaming and integration MUST NOT change the financial results for identical input data. Investment values MUST NOT be automatically inserted into household balances by this integration.

#### Scenario: Financial parity
- **WHEN** the same verified portfolio and price data are loaded before and after integration
- **THEN** financial reports and investment operations produce equivalent results under the existing calculation rules

#### Scenario: Retry an accepted import
- **WHEN** an accepted import is revisited after navigation or reload
- **THEN** the original job/result is recovered without importing the same command a second time

#### Scenario: Household balances remain unchanged
- **WHEN** the owner visits Rational Investment after the migration
- **THEN** the visit does not create household accounts, holdings, transactions, or net-worth contributions

### Requirement: Static deployment without a local backend
Both entry points SHALL run from Rational's static HTTPS deployment and use hosted cloud services. Direct investment links, reloads, scripts, styles, and Wasm assets MUST work beneath the deployment subpath without a localhost API or local timer.

#### Scenario: Open a saved investment link on another computer
- **WHEN** the owner opens a saved performance or positions link on a computer without RobinLab, Rust, or a local backend
- **THEN** the page loads, supports sign-in and cloud synchronization, and displays the authorized investment view
