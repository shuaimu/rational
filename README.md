# Rational

A household money manager — accounts, transactions, budgets, goals, reports —
that has **no backend server of its own**.

There is no API server in this repository, and nothing to deploy but static
files. Everything a server would normally do is done by one of two things:

- **[Mako Cloud](https://github.com/makodb) is the database.** The app holds its
  data in [RxDB](https://rxdb.info) in the browser (IndexedDB) and replicates it
  to a Mako Cloud project over the RxDB pull/push/live protocol. Reads come from
  the local copy, so the app works offline and syncs when it can. Who may read
  or write which document is decided by document policies in the platform, not
  by code in this app — a member of a household sees that household's money and
  nothing else, and the browser cannot talk itself out of that.
- **Edge functions are the only server-side code.** Three small functions run on
  Mako Cloud's edge runtime: `households` (invitations, roles, membership),
  `institution-sync` (pulls transactions from a simulated bank on a schedule),
  and `nightly` (applies categorization rules, detects recurring bills, writes
  net-worth snapshots). Their source is in `functions/`. They are deployed with
  the Mako CLI; there is no server to operate.

The point of Rational is that this is enough to build a real product. It is also
the standing test bed for Mako Cloud: whatever Rational cannot do is a gap in the
platform, and gets fixed there rather than worked around here.

## Running it against your own project

```bash
npm install
cp rational.config.example.json rational.config.json   # your project's values
npm run dev
```

`rational.config.json` holds the endpoint, project id, environment id, and the
**public** project key. All four are public values: the key identifies browser
requests for metering and rate limiting, and authorizes nothing by itself — every
request is still authenticated as a signed-in user and checked against the
environment's document policies. Add your app's origin to the environment's
allowed origins (`mako allowed-origins set --origin https://your.app`) so the
browser may call the API cross-origin.

Create the project, collections, policies, and functions with the Mako CLI; see
`docs/setup.md`.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The app: React, RxDB, and the Mako client. No server code. |
| `functions/` | Edge functions, deployed to Mako Cloud's runtime. |
| `mako/` | Collections, policies, indexes, and buckets, as data. |
| `scripts/` | Project setup and demo seeding through the Mako CLI. |

## Licence

Apache-2.0.
