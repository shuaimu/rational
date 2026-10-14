## Context

See `proposal.md` for motivation. Inspection on 2026-09-27 found:

- Rational `main` at `a02f9fc2cf38b9f4926327473694f163f791df37` is already a standalone React/Vite/RxDB application with a Pages workflow, hash navigation, household policies, and vendored UI sources. Its README still describes it as generated from `makodb/mako-cloud`.
- The current platform exporter deletes non-preserved paths in the destination checkout and can push directly to Rational's `main`. Retirement must include this mechanism, not only documentation.
- Both configs name project `prj_43f3756d4588d7412cbe0b633a455695`. Rational uses environment `env_482f584a064bb6dc32c443f7c746c5af`; RobinLab uses `env_833a71a6da540180b4e64c05cfb90e6d`. These are distinct authentication/data scopes.
- Rational's collections include household `accounts` and `transactions`; RobinLab stores its business rows inside immutable portfolio partitions. The inspected baseline collection names do not overlap, but live inventories including job/cache collections must be reconciled before provisioning.
- RobinLab is single-owner: its auth code, read policies, and API entry point embed a source application-user ID. Its provider credentials and private portfolio branches are not browser-readable. A common environment does not imply household access.
- Rational already has a household Investments screen. Replacing it outright would lose manual holdings workflows and affect household balance calculations.
- RobinLab's current working tree, not just its last commit, contains the completed cloud migrations and unrelated local files. Copying either only HEAD or the entire directory would be incorrect.

## Goals / Non-Goals

**Goals:** Independent application ownership; separate household and investment entry points under one static deployment; shared sign-in with equivalent access isolation; verified consolidation into Rational's current environment without changing financial results.

**Non-Goals:** A full visual rewrite; automatically granting household members investment access; generalized multi-user investment portfolios; merging trade events into household spending transactions; automatically projecting brokerage balances into household net worth; deleting the source environment/repository or rewriting Git history; eliminating Mako SDK dependencies.

Private investment access is the default because it preserves existing behavior. A question about household sharing has been sent to the user; an affirmative sharing choice must revise the authorization requirements before implementation. It is not permission to expose investments to every Rational signup.

## Decisions

### 1. Rational is the canonical repository

Preserve Rational's existing root application and place the reviewed RobinLab source set under `investment/` (including `frontend/`, Cargo workspace/crates, cloud functions, migration tools, and relevant verification/rollback source). Avoid a broad reorganization of the household app during a data migration. Add a small shared auth/config module accessible to both frontend builds. Keep generated Wasm reproducible from its Rust sources, with SDK revisions and toolchains pinned in CI.

Track source provenance and the copied file allowlist. Keep private `.local`, `.env`, credential files, databases/backups, logs, dependencies, and build caches outside the transfer. The current migration work and unrelated modifications must be reviewed separately; do not reset either worktree. Carry this OpenSpec change and the relevant historical migration specifications into Rational's planning home and declare cross-repository implementation scope there before applying outside this repository.

Update Rational's README/contribution guidance and CI to make direct app contributions authoritative. Retire the upstream exporter targeting this repository, including alternate `--repo`/`--dir` forms, before integrated work lands. The guard must run before deletion, commit, or push. Audit any export automation and dedicated publishing credentials. Platform examples/tests can remain platform-owned; they do not regenerate the app. Normal app builds and tests require no `mako-cloud` checkout.

Alternative considered: continue exporting a merged app from the platform. Rejected because it conflicts with independent ownership and retains destructive synchronization. Two permanently independent application repos were also considered; one canonical repo gives one build/config/auth contract while the UI remains separate.

### 2. Two static entry points, one deployment

Keep Rational at `/rational/` and publish Rational Investment at `/rational/investment/`, with hash routes beneath each for Pages-safe reloads. The investment page retains its own dashboard/navigation and gains a **Back to Rational** link. Rational gains an **Investment** link. Preserve the existing household holdings view and its legacy hash route, label it clearly as household holdings, and avoid silently replacing it with the private investment portfolio.

Build the household assets into the root artifact and investment assets into its `investment/` subdirectory; the second build must not empty the first build's output. Configure all Wasm/assets against their entry-point base. Both use the same HTTPS origin, target environment and auth persistence. Lazy/separate bundles keep investment calculations out of the household startup path and prevent global CSS collisions.

Alternative considered: embed the full investment UI inside the household shell. Deferred because the user requested a largely separate homepage and the current UI/data flows already work independently.

### 3. Share authentication, retain scoped data stores

Extract a common session adapter using one environment-scoped persistence key and compatible Mako SDK revision. Both clients must serialize rotating refresh credentials across tabs, restore the latest persisted token before refresh, react to sign-in/sign-out, and clear protected replicas/query caches on identity or authorization-epoch changes. Preserve validated offline access during transient network outages, while definitive revocation clears access. Keep separate household/investment RxDB namespaces keyed by endpoint, project, environment, authenticated user, and relevant authorization scope.

Adopt existing Rational sessions through a tested persistence migration; do not copy source-environment RobinLab tokens into the destination. Resolve and verify the destination application-user identity for the portfolio owner using authenticated account information. Never infer equality from matching email strings or from the developer console identity. Parameterize the investment owner in destination policies and trusted runtime configuration rather than weakening the owner check.

A signed-in unrelated Rational user can follow the investment link but receives a clear access-denied state without downloading private portfolio data. Household membership alone grants no investment rights under the default. Household role policies remain unchanged. Provider/private collections remain inaccessible to browser identities.

Alternative considered: simply point RobinLab at the new environment and share a localStorage key. Rejected: environment-bound credentials, hardcoded owner IDs, refresh rotation, and cached authorization scopes require an explicit session/identity transition.

### 4. Preserve portfolio storage and business identifiers

Use additive destination provisioning after comparing existing live schemas, policies, indexes, and function names. Fail on unexpected collisions instead of replacing Rational resources. Retain current internal investment collection/function identifiers where compatible; public branding does not require renaming hashes, broker identities, or command IDs.

Migrate the immutable portfolio graph, historical heads retained by replay receipts, private provider mappings/watermarks, cache generations and rows, provider usage/counters, durable jobs, command receipts/results, and retained uploads/inputs. Preserve tombstones and indexes as needed for replay and enumeration. Enumerate required collections from live deployments and schemas, not solely the earlier storage-migration manifest. Inventory browser-persisted pending command identities and ensure accepted commands remain replayable after cutover. Unaccepted local requests require explicit reconciliation; do not silently replay them into the destination.

Identify environment-bound owner references and remap only documented fields. Broker user/account IDs are provider identifiers and must stay unchanged. If remapping changes a content-addressed body, rebuild and verify affected references with a recorded mapping; never edit a content-addressed document in place. Issue destination service credentials with minimal scopes, install provider secrets through a protected channel, and verify destination bindings without printing secret values.

No investment data is automatically copied to household `accounts`, `transactions`, or net-worth snapshots. Existing household holdings and investment financial data are each preserved; future cross-product balance reconciliation is a separate design.

### 5. One investment writer environment throughout cutover

Prepare schemas and inactive destination functions first. At final cutover, stop new source API mutation admission and automatic job admission, then drain/reconcile existing work to a stable checkpoint. Inventory and fence every source writer, including retained repository gateways and worker credentials, so stale browser builds cannot continue modifying the old environment. Do not rely on publishing a new frontend to stop old clients.

Take a fresh complete source snapshot after quiescence; existing September cutover exports are evidence, not the current migration source. Preserve all command/replay state before publishing the destination head. Validate logical row counts/digests, graph reachability, counters, secrets/provider mapping availability, and the existing Wasm/native report comparisons. Record destination household baselines and prove the migration did not modify their schemas/policies/data; account for legitimate concurrent household edits without overwriting them.

Only after parity and authorization tests pass, enable the destination API and exactly one destination investment dispatcher, update both frontend configs and allowed origins, and deploy the combined static artifact. Existing Rational household schedules continue independently. The destination dispatcher retains stable hourly command identities and imported receipts so resuming in the same UTC hour cannot duplicate already-accepted work.

### 6. Rollback preserves accepted writes

Before destination writes are enabled, abandon a failed staging attempt and restore source admission only after confirming the destination is inactive. After destination writes are accepted, pause/fence destination investment admission and reconcile jobs; use a verified reverse delta/full current-state transfer before re-enabling source writes. Reverting only the frontend or restoring an old snapshot is not a valid data rollback. Retain protected exports, source resources, and a cutover journal until the new deployment is verified; deletion requires a separate decision.

### 7. Finish verification without a local coordinator

After the completed import, the remaining saved-input comparison runs as a
temporary scheduled Mako function. Separate service credentials allow only reads
of source/destination inputs and heads; another credential writes only a private
migration checkpoint collection. Each invocation compares bounded ordered pages
using the existing `by_job` indexes, persists both continuation cursors with CAS,
and releases its lease. Lost responses and interrupted invocations resume the
last durable checkpoint. Mismatches, changed heads, unexpected counts, or
authorization failures block the verifier. No browser identity can read its
checkpoint collection, and no migration credential can publish the portfolio.

The source remains fenced and the destination remains read-only throughout this
scan. The complete saved-input equality receipt combines with the already sealed
exact comparisons for the other 13 non-head collections and the verified source's
graph/history/captures and nine native/Wasm reports. Identical complete data under
the same calculation build preserves those results without downloading and
recomputing the multi-gigabyte snapshot locally. Pin prior evidence and the source
head in the private verification plan. Final head publication, browser checks,
function promotion, and Pages publication retain their existing gates. Retire the
temporary schedule and scoped credentials after verifying its completed receipt.

## Risks / Trade-offs

- Shared session refresh races → one shared adapter, cross-tab lock/re-read, storage-event propagation, and tests with both entry points open.
- Different environment identity IDs → explicit authenticated identity mapping and negative tests with unrelated Rational users, source tokens, and household members.
- Source writes after snapshot or overlapping schedulers → server-side admission fences, drained jobs, revoked/disabled obsolete writer paths, and schedule observations before and after cutover.
- Incomplete replay/private-state export → live collection inventory and replay tests across completed and in-progress operations, plus provider-secret checks.
- Platform exporter overwrites the merged repo → retire publishing and protect both remote and local destination forms before landing integration.
- SDK/toolchain drift between apps → pin one qualified SDK revision and validate both auth/replication suites before consolidation.
- Shared environment broadens operational blast radius → additive, scoped provisioning; unchanged household authorization; independent investment dispatcher/functions; verify existing Rational flows after deployment.
- Existing Pages site is a public preview → signup stays available as configured, but investment data remains owner-protected at the API and document-policy layers.

## Migration Plan

1. Inventory exact source revisions/local changes and live destination resources; establish Rational ownership and retire upstream export publishing.
2. Move the allowlisted investment sources into a Rational integration branch, add common auth/config, implement the two-entry build/navigation/branding, and port tests.
3. Resolve destination owner identity; provision additive investment schemas/policies/indexes, scoped credentials and disabled functions/schedule. Qualify authorization and migration tooling on synthetic data.
4. Fence source mutations/admission, drain jobs, export current complete state, perform a resumable destination import, and verify parity/replay without enabling background admission.
5. Enable the destination investment API/dispatcher, publish both static entry points, and validate real-browser auth/navigation, financial reads/writes, uploads, imports, cache actions, offline recovery, and cross-tab sign-out.
6. Verify scheduled work progresses with all local APIs/helpers stopped, prove old clients cannot write to source, record completion/rollback evidence, and retain old resources without deleting them.

### Implementation finding: dispatcher lane starvation

The live source has 36 pending hourly jobs. Jobs waiting on durable lanes were
consuming single-dispatch slots while the two lane owners made little progress.
Select runnable lane owners directly alongside the bounded due page, skipping
blocked waiters without incrementing their attempts. Preserve accepted jobs and
checkpoints; verify fairness and recovery before source quiescence.
