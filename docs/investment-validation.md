# Rational Investment integration validation

The integration branch combines both browser entry points and hosted application
code in Rational. Production cutover is **not complete**. At the last authenticated
inspection on September 28, the source remained authoritative; the destination API
was read-only, its dispatcher disabled, and its portfolio head unpublished. These
live facts require rechecking before cutover.

## Completed checks

- Combined static production build, Rational type checks and Investment lint.
- 224 Rational unit tests, 40 hosted Investment function tests, 12 Investment
  frontend tests, 13 migration-tool tests and 78 Rust workspace tests.
- Seven local integration checks using the actual auth/RxDB/Dexie code.
- Nine isolated real-Chrome checks, including concurrent token refresh under Web
  Locks, offline reopen, incomplete graph handling, authorization reset, logout,
  and denial of unrelated users without signing them out of Rational.
- Live Google sign-in, shared authentication across both entry points, cross-tab
  sign-out/sign-in, household navigation, and household offline/online controls.
- Production `/rational/investment/` assets, hash navigation and deep-link refresh.
- Complete rehearsal source graph/history and native/Wasm financial-report parity;
  exact destination parity for the staged portfolio graph, command history,
  cache status and saved input records.
- Public source/build scan against known private credentials and token signatures;
  strict validation of all three retained OpenSpec changes.
- Mako Cloud exporter retirement verified on upstream main; its only workflow is
  CI, with no repository webhooks or deploy keys present at audit time.

Protected source data, exports and operational receipts remain under `.local/`.
The screenshots below contain navigation or synthetic data only.

![Rational navigation with separate Investment entry](images/investment-navigation.png)
![Real-browser qualification results](images/browser-qualification.png)

## Remaining checks

### October 11 resume verification

GitHub access and writes to the Rational checkout work again. Both follow-up PRs
below merged on October 4, but merge alone does not verify deployment. An
unauthenticated probe of the credential inventory route still returns HTTP 404
with an empty body, while `/v1/projects` returns a structured JSON response. The
saved developer session is expired and non-renewable; authenticated inventory is
pending private CLI sign-in. No cloud migration mutations were attempted.

Re-ran successfully: both production builds, Rational type checks, Investment
lint, 224 Rational unit tests, 40 hosted function tests, 12 Investment frontend
tests, 13 migration-tool tests, 78 Rust workspace tests, seven local integration
checks, and all nine isolated real-Chrome checks. Strict OpenSpec validation passes
all three changes. A scan of 566 tracked/build files found no matches for known
private credentials or private-key headers. Protected logs use the
`.local/integration/resume-*` prefix. These checks do not substitute for live
destination parity or cutover validation.

Mako Cloud [PR #4](https://github.com/makodb/mako-cloud/pull/4) and
[PR #11](https://github.com/makodb/mako-cloud/pull/11) are merged and deployed.
The large-document export now succeeds. The import still fails after partial
commits, with the new `worker_internal_transport` diagnostic. A fresh destination
export confirms exact source contents for every imported price record.
[PR #12](https://github.com/makodb/mako-cloud/pull/12) repairs the Caddy route
that blocks credential inventory.
[PR #13](https://github.com/makodb/mako-cloud/pull/13) adds a separate bulk RPC
timeout budget and timeout-specific diagnostics. Its delayed-response regression
fails with the old budget and passes with the fix; 276 related Rust tests and
scoped Clippy pass. Both follow-ups are merged; credential-route deployment remains
blocked by the observed 404, and bulk-timeout deployment remains unverified.

Full staged data/report parity, live Investment accounts/trades/options, import
and provider flows, and admin actions remain pending. The latest source service-key
inventory route also needs the Caddy configuration fix. No live source admission fence, final snapshot,
destination activation or Pages publication has occurred. Follow
[the migration runbook](investment-migration.md) before taking those steps.
