# Rational

Rational combines household money management with **Rational Investment**, a
separate portfolio and options tracker linked from the main app. Both use the
same sign-in and Mako Cloud environment, with separate data and access policies.
No local backend server is required.

The browser apps deploy as static files. Hosted API and scheduled functions
deploy to Mako Cloud. Everything a server would normally do is done by one of two things:

- **[Mako Cloud](https://github.com/makodb) is the database.** The app holds its
  data in [RxDB](https://rxdb.info) in the browser (IndexedDB) and replicates it
  to a Mako Cloud project over the RxDB pull/push/live protocol. Reads come from
  the local copy, so the app works offline and syncs when it can. Who may read
  or write which document is decided by document policies in the platform, not
  by code in this app — a member of a household sees that household's money and
  nothing else, and the browser cannot talk itself out of that.
- **Edge functions are the only server-side code.** `functions/households` runs
  on Mako Cloud's edge runtime and is the only writer of membership: create,
  invite, accept, change role, remove. Membership has to be a claim on the
  member's token, because a document policy can read a trusted claim but cannot
  join a membership table — and only trusted code may write a claim. It is
  deployed with the Mako CLI; there is no server to operate. Anything else
  Rational grows that must run away from the device — pulling transactions from
  a bank connection, a nightly pass over categorisation rules — belongs in the
  same place.

Household categories are organized by financial type, group, then category. Manage them
in Settings → Categories, including search, collapsing groups, moving categories,
and archiving. Group changes flow through local transaction filters, budgets and
cash-flow reports without rewriting transactions. Monarch CSVs do not include group
metadata: standard category names receive suggested groups, unmatched expenses use
Other, and preserved custom types use Custom. After the initial replica completes,
older imported categories receive these groups; untouched, unused starter duplicates
are archived and can be restored. Imported names, IDs and financial types stay intact.

Application behavior is maintained in this repository. Platform defects and SDK
changes are reviewed separately in Mako Cloud repositories.

## The live site

<https://shuaimu.github.io/rational/> is this repository, built and published by
GitHub Pages, and it talks to a real Mako Cloud project — the one
`rational.config.json` names. Sign up with an email and a password and the data
is yours: it lives in that project, syncs to every browser you sign in from, and
survives clearing this one. Browser replication talks directly to Mako Cloud;
application APIs and scheduled jobs run as hosted functions maintained here.

It is a public preview project, so treat it as one: anybody may sign up, and
nothing there is backed up or promised to outlive the preview. Put real money
records in your own project, not this one.

A checkout with no `rational.config.json` — a fresh clone, before you point it
anywhere — runs against an in-browser fake of the same protocol instead, seeded
with a demo household, and says so in a banner across the top. Everything works
there too; none of it leaves the browser.

## Point it at your own project

```bash
git clone https://github.com/shuaimu/rational.git
cd rational
npm install
cp rational.config.example.json rational.config.json   # your project's values
npm run dev
```

`rational.config.json` holds the endpoint, project id, environment id, and the
**public** project key. All four are public values: the key identifies browser
requests for metering and rate limiting, and authorizes nothing by itself — every
request is still authenticated as a signed-in user and checked against the
environment's document policies. This repository commits the file for the
published site; the example file beside it ships with placeholder ids, and while
those are in place the app knows it has no project and runs the in-browser
demo, so replace all of them at once.

The browser calls the API from your own origin, and the platform answers a
cross-origin request only from an origin the environment lists:

```bash
mako allowed-origins set --origin https://shuaimu.github.io
```

Google sign-in also requires an exact return URL in the environment's auth
settings, including its path and trailing slash. For the local Pages-layout
preview, register `http://localhost:5173/rational/`; allowing
`http://localhost:5173/` alone does not cover it. Preserve the production return
URL (`https://shuaimu.github.io/rational/`) and existing provider settings when
adding a development URL with `mako-cloud auth-settings get` and `set`.

Rational shares a durable browser session with Investment. The cloud environment
uses `persistentSessions: true`: sign-in has no fixed expiry, while short-lived
access tokens renew automatically. Sign-out, browser-data removal, and explicit
access revocation still end the session. Authorization changes refresh the session
and rebuild affected local caches instead of signing out both apps.
Renewals save a random request identity before calling the cloud. If a response
is lost or the device sleeps, the same renewal can recover its replacement token
after reopening. This requires the cloud's idempotent refresh support; unrelated
token reuse and explicit revocation still terminate the session.


Create the project, its collections, policies, indexes, and bucket, and deploy
the `households` function with:

```bash
npm run bootstrap -- --endpoint https://cloud.example.com --data-endpoint https://cloud.example.com --functions
npm run seed          # ~200 demo transactions, as a signed-in user
```

`scripts/bootstrap.mjs` drives the `mako` CLI (install it, or point at one with
`--cli`), and is idempotent: rerunning reuses whatever it finds. It writes
`rational.config.json` for you.

Linked household accounts use the latest provider-reported balance. Daily
observations live in `account_balance_snapshots`, separately from transactions;
bank synchronization does not create balance-reconciliation transactions.
Account history uses reported values where available and estimates other dates
from posted transactions, anchored to a reported balance (or the opening balance
when no report exists). Hover over a chart date to see its source. A failed bank
refresh retains the previous reported balance and its timestamp.

For an existing environment, `node scripts/deploy-balances.mjs` provisions the
household-read-only observation collection and its scoped cloud credential, then
deploys `institution-sync` and `nightly` while preserving their limits and schedules.
It accepts either function name to resume a partial deployment. Provider refresh
remains daily with hourly dispatch; this command does not publish the frontend.

## Building and testing

```bash
npm run build         # both entry points into web-dist/
npm run typecheck
npm run test:unit     # node --test over the built selectors
npm run test:browser  # Playwright, against the in-browser fake
```

`npm run build` needs no network beyond dependency installation. Household demo
mode remains available; Investment requires an authenticated, provisioned cloud
environment.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The app: React, RxDB, and the Mako client. No server code. |
| `src/kit/` | The Mako design system the screens are built from — tokens with a light and a dark palette, Radix-based components, Recharts charts — copied here from the platform repository so the application does not require a platform checkout. |
| `src/testing/` | The in-browser fake of the Mako protocol the demo runs on. |
| `functions/` | Edge functions, deployed to Mako Cloud's runtime. |
| `mako/` | Collections, policies, indexes, and buckets, as data. |
| `scripts/` | Project setup and demo seeding through the Mako CLI. |
| `test/`, `test-unit/` | Browser suites against the fake, and unit tests. |

The client, `@mako-cloud/rxdb`, is installed from
[`makodb/mako-rxdb`](https://github.com/makodb/mako-rxdb) until it is published
to npm; swapping the specifier for a version range is then a one-line change.

## Independent application development

This repository is the source of truth for Rational and **Rational Investment**.
Send application changes here. Mako Cloud supplies the database, authentication,
SDKs, and hosted functions; its example/export tooling does not generate this app.

`investment/` contains the investment frontend, Rust/Wasm calculation workspace,
and Mako functions. The investment homepage builds for
`/rational/investment/`, with a link from Rational and shared sign-in. Household
holdings remain separate; investment balances are not automatically counted in
household net worth.

```bash
npm ci
npm ci --prefix investment/frontend
npm run build                  # both static entry points in web-dist/
npm run dev                    # one Vite process serves both apps on port 5173
```

Open `http://localhost:5173/` for Rational or
`http://localhost:5173/investment/` for Rational Investment. Both entry points
support hot reload through the same server. The compatibility command
`npm run dev:investment` (or `npm run dev` inside `investment/frontend`) starts
that same server; run only one of these commands. All API and scheduled sync work
runs in Mako Cloud. Production remains a static site.

Development and production call Mako's HTTPS API directly; Vite serves only
static assets and hot reload. Include `http://localhost:5173` (and
`http://127.0.0.1:5173` if used) in the environment's allowed origins.

Tabs on the same origin share IndexedDB. RxDB elects one sync leader per
protected data scope; follower tabs react to shared local changes and send no
replication requests. Leadership transfers automatically when a tab closes.
Rational uses one grouped live stream for the user directory and one for the
selected household, shared across tabs. Investment has its own protected
scope. Sync status and replica resets are coordinated across tabs as well.

No local backend is required. Credentials, financial exports, and runtime state
must never be committed. See `openspec/changes/integrate-rational-investment/`
for the migration design and implementation progress.

## Licence

Apache-2.0.
