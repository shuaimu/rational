# Rational repository guidelines

Rational and Rational Investment are maintained here independently of mako-cloud.
The household app is at the root; `investment/` is the Rust/Wasm + React investment app.
Mako Cloud runs all API and scheduled work. Do not add a required local backend.

Keep household data and investment ledger models separate. Investment data remains
private to its configured owner; household membership alone grants no access.
Never commit secrets, local financial data, database backups, runtime logs, or `.local`.
Preserve existing work. Shared pure financial logic stays wasm-compatible.

Use the root OpenSpec planning home. The approved integrate-rational-investment
change covers this repo, read-only source inventory in ../robinlab, and retirement
of the Rational exporter in makodb/mako-cloud. Platform SDKs remain dependencies.

Validate affected code with root typecheck/unit/browser tests, investment frontend
lint/build, Rust workspace tests and investment function tests. Real browser checks
are required before cutover. Exactly one investment writer environment/dispatcher
may be active; do not restore stale snapshots over accepted writes.
