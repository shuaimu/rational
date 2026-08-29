# Rational

A household money manager — shared households, accounts, transactions with
splits, categories and tags — that has **no backend server of its own**.

There is no API server in this repository, and nothing to deploy but static
files. Everything a server would normally do is done by one of two things:

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

The point of Rational is that this is enough to build a real product. It is also
the standing test bed for Mako Cloud: whatever Rational cannot do is a gap in the
platform, and gets fixed there rather than worked around here.

## The live demo

<https://shuaimu.github.io/rational/> is this repository, built and published by
GitHub Pages. It talks to no server at all.

A build with no project configured — which is what the published one is — runs
against an in-browser fake of the same protocol, seeded with a demo household.
Sign in with any email and a password of eight characters or more and everything
works: households and roles, accounts, transactions with splits, categories and
tags, and offline edits that queue and settle on reconnect. None of it leaves the browser, and
reloading the page keeps it. The banner across the top says so, because made-up
money should never be mistaken for somebody's money.

The same build becomes a real client the day `rational.config.json` names a
project.

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
environment's document policies. The example file ships with placeholder ids;
while they are in place the app knows it has no project and runs the demo, so
replace all of them at once.

The browser calls the API from your own origin, and the platform answers a
cross-origin request only from an origin the environment lists:

```bash
mako allowed-origins set --origin https://shuaimu.github.io
```

Create the project, its collections, policies, indexes, and bucket, and deploy
the `households` function with:

```bash
npm run bootstrap -- --endpoint https://cloud.example.com --data-endpoint https://cloud.example.com --functions
npm run seed          # ~200 demo transactions, as a signed-in user
```

`scripts/bootstrap.mjs` drives the `mako` CLI (install it, or point at one with
`--cli`), and is idempotent: rerunning reuses whatever it finds. It writes
`rational.config.json` for you.

## Building and testing

```bash
npm run build         # tsc -b, then vite build into web-dist/
npm run typecheck
npm run test:unit     # node --test over the built selectors
npm run test:browser  # Playwright, against the in-browser fake
```

`npm run build` needs no project and no network beyond the install: the demo
build is the ordinary build.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The app: React, RxDB, and the Mako client. No server code. |
| `src/testing/` | The in-browser fake of the Mako protocol the demo runs on. |
| `functions/` | Edge functions, deployed to Mako Cloud's runtime. |
| `mako/` | Collections, policies, indexes, and buckets, as data. |
| `scripts/` | Project setup and demo seeding through the Mako CLI. |
| `test/`, `test-unit/` | Browser suites against the fake, and unit tests. |

The client, `@mako-cloud/rxdb`, is installed from
[`makodb/mako-rxdb`](https://github.com/makodb/mako-rxdb) until it is published
to npm; swapping the specifier for a version range is then a one-line change.

## How this repository is produced

This repository is generated. Rational is developed in the Mako Cloud platform
repository, where its browser suites run against the platform itself, and
`scripts/export-rational-app.mjs` there copies the sources here and writes the
two files that differ for a standalone application (`package.json` and
`vite.config.ts`). Everything outside this README, the licence, the workflow,
and the configuration example is overwritten on the next export.

So pull requests belong upstream, not here — an issue on this repository is a
fine place to start.

## Licence

Apache-2.0.
