# Rational Investment integration validation

The integration branch combines both browser entry points and hosted application
code in Rational. Production cutover is **not complete**. The source environment
remains authoritative; the destination API is read-only, its dispatcher is disabled,
and its portfolio head has not been published.

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

The bulk importer has repeatedly failed after partial commits, without enough
diagnostic detail to identify the remaining cause. Mako Cloud
[PR #4](https://github.com/makodb/mako-cloud/pull/4) provides those diagnostics;
[PR #11](https://github.com/makodb/mako-cloud/pull/11) fixes the reproduced export
size limit. Both require merge and deployment before retrying the cloud checks.

Full staged data/report parity, live Investment accounts/trades/options, import
and provider flows, and admin actions remain pending. The latest source service-key
inventory API also needs deployment. No live source admission fence, final snapshot,
destination activation or Pages publication has occurred. Follow
[the migration runbook](investment-migration.md) before taking those steps.
