## Why

RobinLab now runs entirely on Mako Cloud but remains a separate product from Rational, with a separate environment and sign-in. Bringing it into Rational as **Rational Investment** provides one product and cloud environment while preserving its dedicated trading interface, and making Rational independently maintained prevents platform exports from overwriting application changes.

## What Changes

- Make `shuaimu/rational` the canonical, independently maintained repository for Rational and Rational Investment. Retain the existing Rational application and bring in the investment frontend, Rust/Wasm calculation crates, function sources, deployment tools, and tests from this working tree.
- Retire the `mako-cloud` export path targeting Rational; keep platform SDK dependencies and platform integration tests independently versioned.
- Brand the investment UI **Rational Investment**, with a dedicated homepage linked by an **Investment** entry in Rational and a return link. Preserve RobinLab's trading workflows and Rational's existing household holdings screen/data.
- Share Rational's authenticated session across both entry points. Preserve private investment access by default; household sharing is a pending preference, not implied by using one environment.
- **BREAKING**: migrate the investment runtime from environment `env_833a71a6da540180b4e64c05cfb90e6d` into Rational's configured environment `env_482f584a064bb6dc32c443f7c746c5af` in the existing Rational project. Rebind identities, policies, scoped service credentials, functions, schedules, and browser configuration.
- Preserve existing Rational records and investment ledger/history, provider mappings, command receipts, durable jobs, and caches through a verified, resumable migration with a single active investment writer environment.
- Run automatic brokerage and price refresh admission once per UTC day, with the single investment dispatcher waking hourly; preserve accepted jobs and manual command identities.
- Supersede redundant never-started automatic jobs after owner authorization, preserving manual requests, started work and command receipts; reconcile the browser queue count.
- Build both static frontends into Rational's existing Pages deployment. Require no local Rust API or background process.
- Defer automatic brokerage-account consolidation and household net-worth projection; this change must not duplicate investment balances in Rational.

## Capabilities

### New Capabilities

- `rational-investment-experience`: Dedicated investment homepage, links, shared session lifecycle, retained financial behavior, and static hosting.
- `rational-shared-environment`: Isolated investment access within Rational's environment, state migration, single-writer cutover, and rollback.
- `rational-independent-repository`: Independent application ownership, reproducible builds, and protection from platform exports.

### Modified Capabilities

None. The main `openspec/specs` tree has no existing capability files; completed migration changes remain historical context and their data-integrity requirements continue to apply.

## Impact

- Rational: navigation, auth/session utilities, build/Pages workflow, configuration, docs, CI, and additional investment sources. Existing household collection policies and data remain intact.
- RobinLab: `frontend/`, `crates/`, `mako/`, migration/deployment scripts, relevant native verification/rollback sources, and OpenSpec artifacts move into the canonical repository through a reviewed source inventory. Secrets, databases, logs, caches, and unrelated local changes are excluded.
- Mako Cloud: destination collections/policies/indexes, application identity mapping, service credentials, function deployments and schedules; source environment retained for controlled rollback.
- `makodb/mako-cloud`: narrowly scoped retirement/guard of `scripts/export-rational-app.mjs` and its tests/docs. Application development moves to Rational; a platform checkout is not a build prerequisite.
