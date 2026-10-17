## Purpose

Make Rational and Rational Investment independently maintained applications with reproducible delivery and no destructive regeneration from the Mako Cloud platform repository.

## ADDED Requirements

### Requirement: Canonical application repository
The `shuaimu/rational` repository SHALL contain the maintained source, configuration templates, tests, and deployment instructions for both applications. Application contributions SHALL be made there. A developer MUST be able to build and test the applications without a `mako-cloud` checkout, using declared versioned dependencies and toolchains.

#### Scenario: Fresh clone
- **WHEN** a developer clones Rational and installs its documented dependencies
- **THEN** both application builds and their deterministic tests run without platform workspace packages or private local files

### Requirement: Retire platform overwrite publishing
Supported platform export tooling and automation MUST NOT delete, regenerate, commit over, or push generated application sources to the independently maintained Rational repository. Destination checks MUST occur before destructive filesystem or Git actions, including when a destination is provided as a local directory or alternate remote spelling.

#### Scenario: Export targets Rational
- **WHEN** a platform export command targets the canonical Rational repository or its checkout
- **THEN** it refuses before modifying files or publishing a commit and directs application work to Rational

### Requirement: Safe source consolidation
The consolidation SHALL preserve the reviewed completed investment implementation, relevant verification tooling and Wasm sources/artifacts, and Rational's existing application behavior. It MUST exclude secrets, private financial data, local databases/backups, runtime logs and caches. Unrelated local work MUST NOT be discarded or silently included.

#### Scenario: Copy from the working tree
- **WHEN** the investment sources are consolidated
- **THEN** the resulting repository matches an explicit source inventory that includes required uncommitted migration work and excludes private/generated runtime files

### Requirement: One reproducible static artifact
Rational's delivery workflow SHALL build and validate both application entry points and their assets in one static deployment artifact. The artifact MUST contain no server credentials or financial data, and both application test suites MUST remain runnable independently of publishing.

#### Scenario: Combined production build
- **WHEN** the deployment workflow builds the application repository
- **THEN** the artifact contains both homepages and working assets under their configured paths, without either build erasing the other

### Requirement: One local development server
The root `npm run dev` command SHALL serve Rational at `/` and Rational Investment
at `/investment/` through one Vite process on port 5173. Both entry points SHALL
support source hot updates, direct reloads and their static/Wasm assets without
requiring a second frontend server or local backend.

#### Scenario: Develop both applications
- **WHEN** a developer starts the root dev command with no other app server running
- **THEN** both interfaces load on the same origin and source edits update the corresponding interface
