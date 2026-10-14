## 1. Establish independent application ownership

- [x] 1.1 Record current Rational and RobinLab revisions, inventory required working-tree changes and private exclusions, and create an isolated Rational integration branch without reverting existing work.
- [x] 1.2 Establish Rational's OpenSpec planning home, carry this change and relevant migration history into it, and document the authorized Rational/application and upstream exporter scopes.
- [x] 1.3 Retire or guard Mako Cloud's Rational exporter before any destination deletion/commit/push; cover default, explicit remote, and local checkout targets with focused tests and prepare the upstream change for review.
- [x] 1.4 Audit export automation/publishing access, verify exporter retirement is effective before landing application changes, and update Rational's README/contribution guidance to direct app development to Rational.
- [x] 1.5 Copy the allowlisted investment frontend, Cargo crates/workspace, cloud functions, deployment/verification tools, and required Wasm artifacts into `investment/`; verify provenance and exclusion of credentials, financial data, databases, backups, and logs.

## 2. Build the two application entry points

- [x] 2.1 Add reproducible build/test commands for both apps, align the qualified Mako SDK revision, and configure shared modules without requiring a platform checkout.
- [x] 2.2 Brand the investment UI Rational Investment, add Rational's Investment link and the return link, and preserve the existing household holdings view and bookmarks with clear labeling.
- [x] 2.3 Add Pages-safe investment hash navigation and base-path-aware assets/Wasm under `/rational/investment/`; verify deep-link refresh and development URLs.
- [x] 2.4 Extend the static build and Pages workflow to produce one artifact containing both entry points without output-directory collisions; validate its contents for private data and server credentials.

## 3. Share authentication without broadening access

- [x] 3.1 Extract the common auth/session adapter and environment configuration, preserving existing Rational sessions through a tested storage migration.
- [x] 3.2 Coordinate cross-tab token refresh, sign-in/sign-out, identity changes, authorization-epoch resets, offline recovery, and clearing of both applications' protected state.
- [x] 3.3 Verify the destination portfolio-owner application identity and replace source-owner constants in investment runtime configuration/policies with the explicit destination binding; retain private access unless the user changes that preference.
- [x] 3.4 Separate household and investment local replica namespaces and test owner access plus denial for unrelated users, household members without investment authorization, source-environment tokens, and browser requests for provider/private state.

## 4. Prepare the shared environment

- [x] 4.1 Inventory live source and destination collections, schemas, indexes, policies, identities, functions, secrets metadata, schedules, and writer entry points; record Rational household baselines and fail on unexpected collisions.
- [x] 4.2 Implement additive destination provisioning for all required investment collections and policies while preserving existing Rational resources and allowed origins.
- [x] 4.3 Provision destination-scoped service credentials and transfer provider secrets privately; deploy investment functions and an inactive dispatcher with target-environment bindings.
- [x] 4.4 Implement source mutation/admission fences covering stale clients and retained write gateways; verify existing jobs can drain safely before the final fence.

- [x] 4.5 Fix dispatcher selection so due lane owners progress ahead of blocked waiters; regression-test ownership, future leases, and needs-attention behavior.

## 5. Implement and rehearse state migration

- [x] 5.1 Build a resumable complete cloud-to-cloud export/import manifest covering the portfolio graph/history, caches/status, provider state, usage/counters, commands, jobs/results, uploads/inputs, and required tombstones.
- [x] 5.2 Add explicit identity transformation records, content-addressed graph checks, and destination parity checks for logical rows, counters, digests, mappings, and financial outputs.
- [ ] 5.3 Preserve accepted command IDs and replay receipts across the move; reconcile browser-persisted pending operations and test lost responses, interrupted imports, expired uploads, and incomplete provider operations.
- [x] 5.4 Rehearse resumability, pre-activation rollback, and rollback after a destination write using synthetic state; prove no duplicate provider side effects or hourly admissions.
- [x] 5.5 Deploy a bounded scheduled saved-input verifier with read-only source/destination credentials and a private CAS checkpoint journal; prove scheduled progress without a local coordinator and retain the completed parity receipt before cutover (complete matching cloud-export checksum receipt superseded the partial scan).

## 6. Validate the consolidated implementation

- [x] 6.1 Run Rational type checks/unit tests, investment frontend lint/build and integration tests, Rust workspace tests, hosted function tests, and strict OpenSpec validation.
- [ ] 6.2 Run real-browser tests of cross-entry navigation, existing Rational flows, private investment access, simultaneous refresh, cross-tab sign-out, identity changes, offline restart/recovery, and direct Pages-subpath links.
- [ ] 6.3 Verify financial/report parity and investment accounts/trades/options, positions/performance, workbook upload/reload recovery, SnapTrade flows with available credentials, and admin cache actions against the staged destination.
- [ ] 6.4 Prepare reviewed application/deployment changes, migration evidence, screenshots, and the cutover/rollback runbook; resolve any discovered blockers before touching source admission.

## 7. Cut over and verify autonomous operation

- [x] 7.1 Fence source investment mutation and automatic admission, drain/reconcile pending work, take a fresh protected source snapshot, and verify all source writer paths are inactive.
- [ ] 7.2 Import the verified final state into the destination, publish only after graph/data/report/replay checks pass, and prove the migration has not modified Rational household data or permissions.
- [ ] 7.3 Activate the destination investment API and exactly one investment dispatcher, preserving independent Rational household schedules; verify stable hourly commands across the cutover boundary.
- [ ] 7.4 Publish the combined Rational static artifact with both apps targeting the destination, then smoke-test both entry points from a fresh browser session with no local backend.
- [ ] 7.5 Verify old source clients cannot write, observe destination scheduled progress with local helpers stopped, and record final state, deployment versions, parity evidence, and rollback readiness without deleting source resources.
