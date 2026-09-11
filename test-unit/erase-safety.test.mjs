// The local database is both a replica of the server and the queue of writes that have not reached it yet.
// These tests pin the rule that no code path erases the second role: an open failure that is not a schema
// change keeps the data, and a full resync pushes pending writes before it clears anything.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import "fake-indexeddb/auto";
import { createRxDatabase } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { API_ERROR_VERSION, MemoryReplicationStateStore } from "@mako-cloud/rxdb";

import { isStoredStateIncompatible, openDatabase } from "../dist/src/data/database.js";
import { ScopeStatePersistence } from "../dist/src/data/replication-state.js";
import { ScopeController } from "../dist/src/data/scope.js";
import { Transport } from "../dist/src/data/transport.js";
import { HOUSEHOLD_COLLECTIONS } from "../dist/src/model/types.js";

const quietWarn = console.warn;
console.warn = () => undefined; // RxDB's storage banner
after(() => {
  console.warn = quietWarn;
  // Whatever handle a storage or replication leaves behind must not hold the runner open.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1_000).unref();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const transaction = (id, extra = {}) => ({
  id, household_id: "hh_test", created_at: 1, updated_at: 1, account_id: "acc_1", date: "2026-01-01",
  amount: -100, currency: "USD", description: id, tags: [], splits: [], ...extra,
});

test("isStoredStateIncompatible names exactly RxDB's two stored-state refusals", () => {
  assert.equal(isStoredStateIncompatible({ code: "DB6" }), true);
  assert.equal(isStoredStateIncompatible({ code: "DM5" }), true);
  assert.equal(isStoredStateIncompatible({ code: "COL23" }), false);
  assert.equal(isStoredStateIncompatible({ code: "DB8" }), false);
  assert.equal(isStoredStateIncompatible(new Error("quota")), false);
  assert.equal(isStoredStateIncompatible(null), false);
});

test("an open that fails for a reason other than a schema change keeps the local data", async () => {
  const first = await openDatabase("erase-safety-cap", HOUSEHOLD_COLLECTIONS);
  await first.transactions.insert(transaction("txn_unsynced"));
  await first.close();

  // Saturate the free build's cap on open collections in another database.
  const tiny = { version: 0, primaryKey: "id", type: "object", properties: { id: { type: "string", maxLength: 64 } }, required: ["id"] };
  const filler = await createRxDatabase({ name: "erase-safety-filler", storage: getRxStorageMemory(), multiInstance: false });
  for (let i = 0; i < 14; i += 1) await filler.addCollections({ [`c${i}`]: { schema: tiny } });

  await assert.rejects(openDatabase("erase-safety-cap", HOUSEHOLD_COLLECTIONS), (error) => error.code === "COL23");

  await filler.close();
  const again = await openDatabase("erase-safety-cap", HOUSEHOLD_COLLECTIONS);
  const kept = await again.transactions.find().exec();
  assert.equal(kept.length, 1, "the unsynced transaction survives an open failure that was not about the data");
  await again.remove();
});

/** A Mako server that can expire every checkpoint it has issued so far, and rate-limit pushes for a while. */
function fakeServer({ pushDelayMs = 0 } = {}) {
  const seed = { ...transaction("txn_server_seed", { date: "2025-12-01" }), _deleted: false };
  const state = { epoch: 0, pushMode: "accept", accepted: new Map([["transactions", new Map([[seed.id, seed]])]]), resyncs410: 0 };
  const envelope = (code, message, retry) => ({ apiVersion: API_ERROR_VERSION, error: { code, message, requestId: "req_test", retry } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input, init = {}) => {
    const path = (input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)).pathname;
    if (path.endsWith("/replication/stream")) {
      const body = new ReadableStream({ start(c) { init.signal?.addEventListener("abort", () => { try { c.close(); } catch {} }, { once: true }); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const collection = path.match(/collections\/([^/]+)\/replication/)?.[1] ?? "?";
    if (path.endsWith("/replication/pull")) {
      const request = JSON.parse(init.body);
      const issuedIn = request.checkpoint === null ? null : Number(String(request.checkpoint).split(":")[0]);
      if (issuedIn !== null && issuedIn < state.epoch) {
        state.resyncs410 += 1;
        return json(envelope("checkpoint_expired", "older than the retention window", { kind: "never" }), 410);
      }
      const store = state.accepted.get(collection) ?? new Map();
      const documents = request.checkpoint === null ? [...store.values()] : [];
      return json({ documents, checkpoint: `${state.epoch}:${collection}:${store.size}` });
    }
    if (path.endsWith("/replication/push")) {
      const request = JSON.parse(init.body);
      if (state.pushMode === "rate_limited") return json(envelope("rate_limited", "too many requests", { kind: "after_delay", afterMs: 100 }), 429);
      if (pushDelayMs > 0) await sleep(pushDelayMs);
      const store = state.accepted.get(collection) ?? new Map();
      state.accepted.set(collection, store);
      const outcomes = request.rows.map((row) => { store.set(row.newDocumentState.id, row.newDocumentState); return { mutationId: row.mutationId, status: "accepted" }; });
      return json({ outcomes });
    }
    return json(envelope("not_found", "no such route", { kind: "never" }), 404);
  };
  return { state, fetch, reachedTransactions: () => (state.accepted.get("transactions")?.size ?? 0) - 1 };
}

const config = {
  mode: "live", endpoint: "https://cloud.example.test", projectId: "prj_abcdefgh", environmentId: "env_abcdefgh",
  publicProjectKey: "mako_pk.example", functionsEndpoint: null, signIn: { providers: [], magicLinks: false },
  retryTimeMs: 50, startOffline: false,
};
const user = { id: "usr_test", email: "p@example.test", status: "active", authorizationEpoch: 1 };
const auth = {
  client: { validAccessToken: async () => "token", refreshSession: async () => ({ accessToken: "token" }) },
  refresh: async () => user, currentUser: () => user, restore: async () => user, refreshUnavailable: false,
};

let scopes = 0;
async function openScope(fetch) {
  scopes += 1;
  const name = `erase-safety-scope-${scopes}`;
  const transport = new Transport(fetch, true);
  const controller = new ScopeController({
    definition: { name, databaseName: `rational-${name}`, collectionIds: HOUSEHOLD_COLLECTIONS, householdId: "hh_test", pollIntervalMs: 0 },
    dependencies: { config, auth, transport },
    state: new ScopeStatePersistence({ projectId: config.projectId, environmentId: config.environmentId, scopeName: name, collectionIds: HOUSEHOLD_COLLECTIONS }, new MemoryReplicationStateStore()),
    onAuthenticationRequired: () => undefined,
  });
  await controller.open(1);
  await until(() => controller.state.initialSynced, 30_000, "the first pull");
  return { controller, transport };
}

async function writeOffline(controller, transport, count) {
  transport.setOnline(false);
  for (let i = 0; i < count; i += 1) {
    await controller.session.collections.transactions.insert(transaction(`txn_offline_${i}`));
    controller.noteLocalWrite();
  }
}

test("a full resync pushes every write that never left the device before erasing anything", async () => {
  const server = fakeServer({ pushDelayMs: 20 });
  const { controller, transport } = await openScope(server.fetch);
  await writeOffline(controller, transport, 30);

  server.state.epoch += 1; // the device's checkpoint is past retention now
  transport.setOnline(true);
  controller.reSync();
  await until(
    () => controller.state.fullResyncs === 1 && controller.state.initialSynced && controller.session !== null,
    30_000,
    "the resync to finish and the new generation to be live",
  );

  assert.equal(server.reachedTransactions(), 30, "every offline write reached the server");
  assert.equal(controller.state.fullResyncs, 1);
  assert.ok(server.state.resyncs410 >= 1, "the server did refuse the stale checkpoint");
  const onDevice = await controller.session.collections.transactions.find().exec();
  assert.equal(onDevice.length, 31, "the device holds the server's copy: seed plus the thirty it saved");
  await controller.remove();
});

test("offline writes are never erased while the server is rate-limiting, and sync once the limit lifts", async () => {
  // A device reconnects into a rate limit with its checkpoint expired. RxDB holds the whole replication in
  // error-retry while the push keeps being refused, so the resync cannot even begin -- which is the safe
  // outcome only because nothing is erased. The writes must stay on the device and reach the server later.
  const server = fakeServer();
  const { controller, transport } = await openScope(server.fetch);
  await writeOffline(controller, transport, 5);

  server.state.epoch += 1; // the device's checkpoint is now past retention
  server.state.pushMode = "rate_limited";
  transport.setOnline(true);
  controller.reSync();
  await sleep(1_500); // long enough for many refused push attempts

  assert.equal(server.reachedTransactions(), 0, "nothing could be pushed while rate-limited");
  assert.equal(controller.state.fullResyncs, 0, "and nothing was erased while it could not be saved");
  const held = await controller.session.collections.transactions.find().exec();
  assert.equal(held.length, 6, "the five offline writes and the server seed are all still on the device");

  server.state.pushMode = "accept";
  await until(() => server.reachedTransactions() === 5, 30_000, "the writes to drain after the limit lifts");
  assert.equal(server.reachedTransactions(), 5, "all five arrived once the limit passed");
  await controller.remove();
});
