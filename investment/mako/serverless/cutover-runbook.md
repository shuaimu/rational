# Serverless compute cutover

The storage migration already uses Rational / robinlab in Mako Cloud. This
procedure changes compute only. Never reinitialize the portfolio or restore the
old SQLite snapshot over accepted cloud writes.

## Current state

Normal routing targets the hosted API (version 6), and worker version 7 runs under
one enabled dispatcher (`sch_eds861nfcp7vmojq`). The local API/timer is stopped.
A fresh quiescent version-42 export and protected native rollback binary are
retained. Browser upload/recovery and post-switch write/replay checks passed.
The checklist below records the switch procedure for future deployments.

Protected evidence, test accounts, preserved binary/configuration and credentials
are under `.local/`; never commit or attach these to a public issue. Screenshots
contain portfolio data. Runtime public identifiers are in `mako/runtime.json`.

## Finish qualification

1. Upload the empty qualification workbook using the isolated browser and verify
   admission, reload recovery, completion and local version catch-up. Verify the
   two financial manifest roots and next-ID counters did not change.
2. Drain temporary jobs and stop the manual schedule-tick helper. Reconcile all
   synthetic records; the four cache fixture rows have already been removed.
3. Confirm Rust/domain/Wasm and function tests, frontend tests/lint/build, strict
   OpenSpec validation and the hosted route inventory. Keep the current reports.

## Quiesce and switch

1. Confirm the native scheduled-sync and price-cache recovery journals are idle or
   completed. Reconcile any accepted work using its original command ID.
2. Preserve the native executable and environment privately, with its checksum.
   Stop the native process after verifying the last accepted operation completed.
   If more native comparison work is needed, restart with
   `SNAPTRADE_SYNC_INTERVAL_MINUTES=0`; no two import schedulers may run together.
3. Capture a fresh `mako-export` into a new private directory. The exporter pins
   the portfolio head. Use a separate worker session while the native process is
   still running because its credential file is locked. Compare financial roots,
   ID counters, row counts and financial reports with the quiescent live dataset;
   keep pre-cutover command IDs for replay checks.
4. Reconcile/publish a complete cache generation if the native price writer
   changed any cache rows after qualification. There must be no outside cache
   writer when the cloud cache maintenance lane becomes authoritative.
5. Change normal frontend routing to the cloud endpoint and remove the local
   Vite proxy. Enable cloud hourly/quote admission, package and deploy both API
   and worker from the validated source. Enable exactly one dispatcher schedule.
   Keep the no-data qualification schedule paused.
6. Restart the normal frontend. Verify no port-3000 listener and no temporary tick
   helper, then exercise reads, a reversible mutation, original-command replay,
   empty/repeated import, replica catch-up and a real hosted schedule tick. Check
   hourly deduplication and job progress without the browser being open.
7. Remove temporary test origins and dev servers after preserving evidence. Record
   deployed version hashes, schedule state, final process inventory and exports.
   Update README, AGENTS and OpenSpec context to describe the final runtime.

## Roll back compute against current Mako state

Pause the dispatcher and disable new hourly/quote admission first. Prevent new
mutation traffic and reconcile every running, committing or needs-attention job;
never abandon a cache job in the middle of its captured mutation plan. Preserve
accepted cloud command IDs and complete cache generations.

Prefer promoting a known-good hosted function version when its data contracts
remain compatible. For a native rollback, start the preserved native binary and
private environment against the **current** Rational / robinlab dataset. Keep
`SNAPTRADE_SYNC_INTERVAL_MINUTES=0` until cloud dispatch is confirmed stopped and
all cloud work is reconciled. Explicitly restore the frontend's native API route
and proxy only as part of this operator rollback; normal cloud operation must
have no automatic localhost fallback. Resume at most one importer.

The historical export is for comparison and recovery investigation, never an
instruction to overwrite newer state. Retain native worker/provider credentials
through the agreed rollback window. After the window, retire unused native
credentials, qualification functions/secrets and obsolete local runtime files;
retain command receipts and required replay results.
