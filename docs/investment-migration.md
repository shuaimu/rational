# Rational Investment migration

Rational owns the household app, Investment frontend, calculation crates, and
hosted application functions. Platform fixes are reviewed in `makodb/mako-cloud`.
The exporter retirement change (Mako Cloud PR #10) is merged. Its former entry
point fails before touching files or Git, including when given an explicit remote.

## Current state

On October 13, all 14 staged non-head collections passed exact logical comparison
with the rehearsal source. The staged graph, 48 accepted commands, 60 retained
historical roots, and 850 saved artifacts also passed verification; all nine
financial reports matched between native and Wasm calculations. This remains a
rehearsal baseline, not the final cutover snapshot.

Source admission was fenced in draining mode with the source owner binding. All
active checkpoints and the terminal cleanup cursor finished; 335 accepted queued
jobs remain preserved for transfer. The source dispatcher is paused. Source API
and jobs versions 8/10 and all four retained writer/qualification functions now use
credential-free closed handlers; every probe returned 503. The retained native
worker identity is disabled, and all 14 source write-capable service credentials
are retired. After waiting a full claim lease, quiescence was verified again.
The final protected source snapshot is now being exported.

Destination API/jobs versions 2/2 remain read-only, its Investment dispatcher is
paused, and no portfolio head has been published. Household schedules remain
independent. The source remains authoritative. Final snapshot/reconciliation,
destination activation, and combined Pages publication have not occurred.

The installed `mako-cloud` CLI includes the merged PR #16 refresh-cookie fix. A
fresh login now reports a renewable session. Credential inventory succeeds after
the platform deployment: 18 source credentials, including 14 active write-capable
service credentials, and 49 destination credentials were inventoried. All 142
metadata reads succeeded; schemas, policies, indexes, origins, function bindings,
and mapped owner identities match the previously verified inventory. Task 4.1 is
complete. Private credential scopes and writer-fence inputs are preserved locally.

A fresh export of all 15 destination Investment collections completed, including
2,017 saved-input records (207,811,868 bytes) with no failed records. The staged
portfolio graph, command history, cache status, and saved inputs retain their
rehearsal contents. The price baseline still contained 1,568 verified records.
A new import was admitted for the remaining 36,616 rehearsal price records, using
that fresh baseline to skip only verified identical rows. This is staging work;
final cutover still requires a fresh fenced source snapshot.

After import admission, public routes began returning empty Caddy HTTP 403
responses. Operator investigation through the cluster gateway found a latched
control-plane audit readiness failure; the admission guard invalidated its preview
approval. Storage remained healthy and recorded one SQLite busy timeout. A
transient lock timeout is the leading trigger, but this release did not log the
failed audit operation. Restarting only the control plane restored all four private
readiness checks. [Mako Cloud PR #17](https://github.com/makodb/mako-cloud/pull/17)
adds bounded audit retries and failure diagnostics, with regression tests. All eight
CI checks passed; PR #17 was merged and deployed on October 12 (release
`696d364433e4025d4c87df046e56f6f858c76dd07a1e16cfb79cfdfbd32628a7`).
The approved preview renewal restored public access. All four private readiness
checks passed, running binaries matched the verified release, and configuration
and retained backup state were unchanged. Authenticated credential inventories
succeeded for both environments. The installed CLI automatically renewed its
expired session without another sign-in.

Read-only inspection of durable control state verified that the existing price
import succeeded: all 36,616 rows committed, zero failures. The interrupted
household export also succeeded with 15 rows. No replacement import was submitted.
The existing price-import journal now records the successful receipt, and the
household export resumed with its original job ID. A fresh destination price export
verified all 38,184 rehearsal records exactly. All 13 household collections are
sealed in the protected baseline. Remaining staging imports have resumed. Job IDs
and incident evidence are in
`.local/integration/current-status.json` and `platform-incident-20261012/`.

Public bindings are generated from `rational.config.json` and
`investment/mako/owner.json`. The configured owner is an existing active Rational
application identity verified by browser sign-in. Household membership does not
authorize Investment access. No application-user credentials are copied between
environments. Service keys and provider secrets stay in cloud secret storage.

## Protected evidence

Keep inventories, receipts, exports and import journals under `.local/integration/`
(mode 0700; files 0600). Do not commit or attach them to PRs. The source manifest
in `docs/investment-source-manifest.json` records code provenance only.

The protected rehearsal includes all 15 investment collections, complete public
and private portfolio graphs and command history, prices, provider logs/counters,
job coordination and lanes, accepted jobs/results, uploads and private inputs.
`verify-investment-snapshot.mjs` checks every retained command root, immutable
content digest, capture manifest, and native/Wasm financial report parity. It
never prints financial values. Environment/user identifiers do not appear in
exported documents: only policies, auth namespaces and function bindings change.
SnapTrade provider user IDs and secrets retain their provider identity.

An empty destination namespace starts without source tombstones. Deleted source
rows remain absent; immutable command history preserves ledger replay. Do not
reuse a destination with unexplained preexisting rows. Compare complete logical
row sets, not just counts. Existing Rational household collection data, schemas,
policies, indexes, functions and schedules must remain unchanged by migration;
independent household writes must be attributed rather than overwritten.

## Rehearsal and validation

```sh
npm ci
npm ci --prefix investment/frontend
npm run typecheck
npm run test:unit
npm run test:investment
npm --prefix investment/frontend run lint
node investment/frontend/scripts/mako-local-integration.mjs
python3 -m unittest discover -s test-unit/migration -p 'test_*.py'
cargo test --manifest-path investment/Cargo.toml --workspace
openspec validate --all --strict
```

For the browser equivalent, run
`node investment/frontend/scripts/build-browser-qualification.mjs`, serve only
`.local/integration/browser-check` on a separate local origin (for example 5180),
and click **Run browser checks**. Its fixture intercepts all network access and
uses isolated synthetic data; never serve it on the app origin.

The local integration fixture exercises actual auth/RxDB/Dexie code, incomplete
graphs, offline reopen, token renewal, deletion/catch-up, epoch resets and logout.
Synthetic migration tests cover head-last visibility, lost-response replay,
rollback after a new destination write and stable hourly job IDs. They complement
live policy checks and browser checks; they do not replace them.

## Transfer commands

Set `MAKO_CLI` to an installed CLI entry point. No platform checkout is needed by
the app build; operator tools accept the CLI path explicitly. Authenticate the
CLI privately. The migration scripts accept a profile and pin every journal to
its project, endpoint and environment. Reuse a journal only for the same snapshot.

```sh
python3 scripts/investment-transfer.py snapshot --cli "$MAKO_CLI" \
  --environment SOURCE_ENV --output .local/integration/final-source \
  --collections COLLECTION_LIST
node scripts/verify-investment-snapshot.mjs .local/integration/final-source \
  /path/to/native/invoke --quiescent
python3 scripts/investment-transfer.py import --cli "$MAKO_CLI" \
  --environment DESTINATION_ENV --output .local/integration/final-import \
  --snapshot .local/integration/final-source --collections NON_HEAD_COLLECTIONS
```

The current platform bulk importer has a 256 KiB internal request limit. Small
rows are grouped into bounded batches. Import `robinlab_inputs` separately with
`scripts/investment-large-import.mjs`, the destination config, an installed CLI entry point and a private journal
directory. This uses short-lived audited explorer grants, verifies exact
immutable collisions, and resumes with the same mutation IDs. Never pass
credentials in arguments themselves.

For collections larger than the platform's 512 MiB bulk-artifact limit, use
`--paged-explorer-collections robinlab_inputs`. This writes bounded pages directly
to NDJSON, requires one unchanged snapshot handle and strictly increasing IDs,
and seals only an exhausted snapshot. An expired cursor stops the export; rerun
only while the source remains frozen. Verification and reconciliation stream
NDJSON instead of constructing a single JavaScript string for the collection.

Bulk export of captures larger than 192 KiB requires Mako Cloud PR #11. The
rehearsal used audited explorer browsing with a 2 MiB page budget and a single
stable snapshot. Do not combine unrelated pages or seal an incomplete download.
If a bulk job fails after partial commits, export the affected destination
collection and use a fresh import journal with `--existing-snapshot` to skip only
verified identical rows. A terminal job is never silently restarted.

Bulk job `succeeded` alone is insufficient: reject nonzero failed-record counts
and verify a fresh destination export against the sealed source before publishing.

For a staged rehearsal, keep destination admission read-only. After the final
source fence, `investment-reconcile.mjs` compares the new source snapshot with
a verified destination staging baseline. It previews changes by default;
`--apply` uses destination revisions and refuses any unexpected intervening
write. `--concurrency 4` allows at most four independent document comparisons
and mutations at once; receipts are saved after each settled batch, including
when one operation fails. The default remains sequential. Re-export and compare
non-head collections before separately publishing the final head with
`--publish-head`.

## Cutover order

1. Retire the platform exporter; prepare the combined Pages artifact and browser
   checks. Record live source/destination function versions, schedules, service
   key metadata, worker identity and retained repository gateway.
2. Before deploying the new source API bundle, set its `ROBINLAB_OWNER_ID` secret
   to the **source** owner and update its function configuration to attach that
   secret. The old source API embedded its owner in code; deploying the new bundle
   without this configuration would deny legitimate status reads. Deploy source
   API admission in `draining` mode. New mutations and provider
   work return 503 with the destination URL; job-status reads remain available.
   Deploy source jobs in `draining` mode. Finish checkpointed work without
   admitting hourly jobs or starting queued work. Accepted unstarted jobs retain
   IDs, inputs and due times for transfer. Needs-attention work requires explicit
   reconciliation; never repeat an uncertain provider registration.
3. Pause the source schedule, wait out the longest invocation and claim lease,
   and verify no job is running/committing or carries a revision-dependent active
   checkpoint. Fence the retained repository gateway and source worker identity;
   revoke source write-capable service credentials after recording how to reissue
   them for rollback. Confirm stale browser, worker and direct service writes fail.
   Packaging with `--mode closed` also emits a credential-free `retired-writer`
   bundle. Use it for the retained repository gateway and any inventoried legacy
   writer/qualification functions; update each function's config to detach its
   secrets. This bundle always returns 503 and has no storage/provider client.
   Deploying it does not replace revoking direct credentials or disabling workers.
4. Take a **fresh** complete snapshot after fencing. Rehearsal snapshots are not
   cutover inputs. Validate graph/history, cache status/digest, accepted command
   IDs, provider mappings, counters, upload expiration and artifact references.
5. Import non-head state into the inactive destination. Re-export and compare
   exact logical records/digests. Publish the head only with `--publish-head`
   after those checks pass, then verify report/replay parity and real-browser
   access under read-only functions. Preserve source resources.
6. Deploy destination API/jobs in `active` mode and enable exactly one destination
   investment schedule. The household schedules remain independent. Stable
   `hourly_*` command IDs prevent duplicate admission within the same UTC hour.
7. Publish both static entry points together. Verify direct hash links, Wasm
   assets, owner and non-owner behavior, cross-tab sign-out, offline recovery,
   accounts/trades/options, reports, uploads, provider flows and cache actions.
   Observe cloud scheduled progress with local migration helpers stopped.
8. Save versions, parity receipts, fence tests and rollback readiness privately.
   Update this document's active-state paragraph only after these steps complete.

New devices recover pending accepted jobs from the owner-authenticated `/jobs`
API; status responses exclude provider inputs and secrets. A saved upload resumes
with its original IDs and workbook digest, subject to its original expiry. Do
not silently extend expiry or submit a replacement for an uncertain accepted write.

`investment/mako/environment-migration.json` records the exact source/destination
owner bindings and identity-preserving transformations. On the same browser origin,
the frontend moves only the known owner's pending command, upload and job journals
to the destination namespace before cleaning up obsolete caches. It preserves IDs,
upload progress and accepted versions; conflicts stop initialization and retain the
originals. Authentication sessions and replicated databases are never copied.
Browser storage does not cross origins: a fresh device or the GitHub Pages origin
uses cloud job recovery, and unfinished local uploads require the original workbook.

## Rollback

Before destination activation, keep its schedule disabled and functions read-only.
Investigate or re-import from the frozen source; do not overwrite unrelated rows.
To resume the source, first prove destination admission and workers are fenced,
then reissue source-scoped credentials and restore exactly one source schedule.

After any destination write, the destination is authoritative. Fence admission
and workers there, finish/reconcile checkpoints, export its **current** state,
verify all accepted command receipts, and migrate that state back under the same
head-last protocol. The old source snapshot is not a valid rollback. Never run
both environments' dispatchers or restore SQLite over accepted cloud writes.

The retained Rust server is a verification/explicit rollback tool, not part of
normal operation. Its runtime validation is still pinned to the source environment,
and the generated destination config deliberately contains no worker identity.
Starting it against the destination requires a separate reviewed provisioning and
configuration change; `cargo run` is not a destination rollback procedure.
