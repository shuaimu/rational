import assert from "node:assert/strict";
import { test } from "node:test";
import { MappedPlaid } from "../functions/institution-sync/plaid-mapped.ts";
import { compatibleAccount, providerAccounts, validateMappings } from "../functions/shared/plaid-mapping.ts";

function fixture() {
  const docs = new Map(); let revision = 0; let exchanges = 0; let now = Date.UTC(2026, 9, 16);
  const calls = []; const pages = new Map(); let failWrite = null;
  const providers = [
    { account_id: "bank-a", name: "Checking", type: "depository", subtype: "checking", mask: "1111", balances: { current: 1000, iso_currency_code: "USD" } },
    { account_id: "bank-b", name: "Card", type: "credit", subtype: "credit card", mask: "2222", balances: { current: 50, iso_currency_code: "USD" } },
  ];
  const store = {
    async read(collection, id) { return structuredClone(docs.get(`${collection}/${id}`) ?? null); },
    async write(collection, id, body, expected) {
      if (failWrite?.(collection, body)) throw new Error("interrupted write");
      const key = `${collection}/${id}`; const prior = docs.get(key);
      assert.equal(prior?.revision ?? null, expected, "writes must use the revision they read");
      docs.set(key, { body: structuredClone(body), revision: String(++revision), _deleted: false });
    },
    async remove(collection, doc) { docs.set(`${collection}/${doc.body.id}`, { ...doc, revision: String(++revision), _deleted: true }); },
    async list(collection, field, value) { return structuredClone([...docs].filter(([key, doc]) => key.startsWith(collection + "/") && doc.body[field] === value).map(([,doc]) => doc)); },
  };
  for (const [id, type, balance] of [["a", "checking", 100000], ["b", "credit", -5000]]) {
    docs.set(`accounts/${id}`, { body: { id, household_id: "home", type, currency: "USD", opening_balance: balance }, revision: String(++revision), _deleted: false });
  }
  const call = async (path, body) => {
    calls.push({ path, body });
    if (path === "/item/public_token/exchange") { exchanges++; return { item_id: "item-one", access_token: "PRIVATE" }; }
    if (path === "/accounts/get") return { accounts: providers };
    if (path === "/transactions/sync") {
      const queue = pages.get(body.options.account_id) ?? [];
      const answer = queue.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? { added: [], modified: [], removed: [], next_cursor: "done", has_more: false };
    }
    throw new Error(path);
  };
  const client = new MappedPlaid(store, call, "production", () => now);
  return { docs, store, client, pages, calls, providers, exchanges: () => exchanges, fail: fn => { failWrite = fn; }, advance: () => { now += 86400001; } };
}
const txn = (accountId, id, amount, extra = {}) => ({ account_id: accountId, transaction_id: id, amount, date: "2026-10-01", name: id, pending: false, iso_currency_code: "USD", ...extra });
const page = (added = [], extra = {}) => ({ added, modified: [], removed: [], next_cursor: "done", has_more: false, ...extra });
async function linked(f) {
  const link = await f.client.exchange("public-one", "home", "Bank");
  await f.client.map(link.linkId, "home", [{ providerAccountId: "bank-a", accountId: "a" }, { providerAccountId: "bank-b", accountId: "b" }]);
  return link;
}
function balance(f, accountId) {
  return f.docs.get(`accounts/${accountId}`).body.opening_balance + [...f.docs].filter(([key, doc]) => key.startsWith("transactions/") && !doc._deleted && doc.body.account_id === accountId).reduce((sum, [,doc]) => sum + doc.body.amount, 0);
}

test("one exchange maps several accounts; retry and reload reuse the saved Item without leaking credentials", async () => {
  const f = fixture(); const link = await f.client.exchange("public-one", "home", "Bank");
  assert.equal(link.accounts.length, 2);
  assert.ok(!JSON.stringify(link).includes("PRIVATE"));
  assert.deepEqual(await f.client.pending("home"), [link]);
  assert.deepEqual(await f.client.exchange("public-one", "home", "Bank"), link);
  assert.equal(f.exchanges(), 1);
  await linked(f);
  assert.equal(f.exchanges(), 1);
  assert.equal((await f.client.pending("home")).length, 0);
  const connection = f.docs.get(`connections/${link.linkId}`).body;
  assert.deepEqual(connection.account_ids, ["a", "b"]);
  assert.ok(!JSON.stringify(connection).includes("PRIVATE"));
});

test("accounts, cursors and historical opening balances remain isolated on initial sync and replay", async () => {
  const f = fixture(); const link = await linked(f);
  f.pages.set("bank-a", [page([txn("bank-a", "deposit", -100), txn("bank-a", "pending", 12, { pending: true })])]);
  f.pages.set("bank-b", [page([txn("bank-b", "charge", 20)])]);
  assert.equal((await f.client.sync(link.linkId, "home")).pending, true);
  assert.equal((await f.client.sync(link.linkId, "home")).pending, false);
  assert.equal(balance(f, "a"), 100000);
  assert.equal(balance(f, "b"), -5000);
  const ordinary = [...f.docs].filter(([key, doc]) => key.startsWith("transactions/") && !doc.body.adjustment);
  assert.equal(ordinary.length, 2, "pending transactions are not booked");
  assert.equal(ordinary.find(([,doc]) => doc.body.external_id === "deposit")[1].body.account_id, "a");
  assert.equal(ordinary.find(([,doc]) => doc.body.external_id === "charge")[1].body.account_id, "b");
  const before = f.docs.size;
  f.advance();
  f.pages.set("bank-a", [page([txn("bank-a", "deposit", -100)])]);
  await f.client.sync(link.linkId, "home");
  assert.equal(f.docs.size, before, "a replay does not duplicate history or reconciliation entries");
  assert.equal(balance(f, "a"), 100000);
  const syncCalls = f.calls.filter(call => call.path === "/transactions/sync");
  assert.deepEqual(syncCalls.map(call => call.body.options.account_id), ["bank-a", "bank-b", "bank-a"]);
  assert.equal(syncCalls[2].body.cursor, "done");
});

test("wrong household, duplicate mappings, mismatched currencies and cross-account responses are refused", async () => {
  const f = fixture(); const link = await f.client.exchange("public-one", "home", "Bank");
  await assert.rejects(f.client.map(link.linkId, "other", [{ providerAccountId: "bank-a", accountId: "a" }]), /unavailable/);
  await assert.rejects(f.client.map(link.linkId, "home", [{ providerAccountId: "bank-a", accountId: "a" }, { providerAccountId: "bank-b", accountId: "a" }]), /only once/);
  f.docs.get("accounts/a").body.currency = "CAD";
  await assert.rejects(f.client.map(link.linkId, "home", [{ providerAccountId: "bank-a", accountId: "a" }]), /currencies/);
  f.docs.get("accounts/a").body.currency = "USD";
  await linked(f);
  f.pages.set("bank-a", [page([txn("bank-b", "wrong", 10)])]);
  await assert.rejects(f.client.sync(link.linkId, "home"), /unmapped/);
  assert.equal([...f.docs.keys()].filter(key => key.startsWith("transactions/")).length, 0);
});

test("an interrupted page preserves its cursor and replays existing writes without duplicating money", async () => {
  const f = fixture(); const link = await linked(f);
  const batch = page([txn("bank-a", "first", 5), txn("bank-a", "second", 7)]);
  f.pages.set("bank-a", [batch]);
  f.fail((collection, body) => collection === "transactions" && body.external_id === "second");
  await assert.rejects(f.client.sync(link.linkId, "home"), /interrupted/);
  assert.equal(f.docs.get(`plaid_items/${link.linkId}`).body.mappings[0].cursor, "");
  f.fail(null); f.pages.set("bank-a", [batch]);
  await f.client.sync(link.linkId, "home");
  assert.equal(balance(f, "a"), 100000);
  assert.equal([...f.docs.values()].filter(doc => !doc._deleted && ["first", "second"].includes(doc.body.external_id)).length, 2);
});

test("pagination mutation rewinds to the start of the update, not the failed page", async () => {
  const f = fixture(); const link = await linked(f);
  const error = Object.assign(new Error("pagination changed"), { providerCode: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
  f.pages.set("bank-a", [page([], { next_cursor: "partial", has_more: true }), error]);
  await f.client.sync(link.linkId, "home");
  assert.equal(f.docs.get(`plaid_items/${link.linkId}`).body.mappings[0].cursor, "partial");
  await assert.rejects(f.client.sync(link.linkId, "home"), /pagination changed/);
  assert.equal(f.docs.get(`plaid_items/${link.linkId}`).body.mappings[0].cursor, "");
  await f.client.sync(link.linkId, "home");
  assert.equal(f.calls.filter(call => call.path === "/transactions/sync").at(-1).body.cursor, undefined);
});

test("provider balances use liability signs and never silently assume an unknown currency", () => {
  const f = fixture(); const accounts = providerAccounts({ accounts: f.providers });
  assert.equal(accounts[1].balance, -5000);
  assert.equal(compatibleAccount({ ...accounts[0], currency: "" }, { type: "checking", currency: "USD" }), false);
  assert.throws(() => validateMappings([{ providerAccountId: "missing", accountId: "a" }], accounts), /not part/);
});

test("bank sign-in creates accounts from provider data without pre-existing manual accounts", async () => {
  const f = fixture(); f.docs.delete("accounts/a"); f.docs.delete("accounts/b");
  const link = await f.client.exchange("public-one", "home", "Bank");
  const selections = link.accounts.map(account => ({ providerAccountId: account.id, create: true }));
  await f.client.map(link.linkId, "home", selections);
  const created = [...f.docs.values()].filter(doc => doc.body.connection_id === link.linkId);
  assert.equal(created.length, 2);
  const checking = created.find(doc => doc.body.external_id === "bank-a").body;
  const credit = created.find(doc => doc.body.external_id === "bank-b").body;
  assert.equal(checking.name, "Checking (…1111)");
  assert.equal(checking.opening_balance, 100000);
  assert.equal(credit.opening_balance, -5000);
  assert.equal(checking.institution, "Bank");
  assert.equal(checking.household_id, "home");
  f.pages.set("bank-a", [page([txn("bank-a", "deposit", -100)])]);
  await f.client.sync(link.linkId, "home");
  await f.client.sync(link.linkId, "home");
  assert.equal(balance(f, checking.id), 100000);
  assert.equal(balance(f, credit.id), -5000);
  assert.equal([...f.docs.values()].find(doc => doc.body.external_id === "deposit").body.account_id, checking.id);
  const before = structuredClone([...f.docs.entries()].filter(([key]) => key.startsWith("accounts/")));
  f.providers[0].balances.current = 999;
  await f.client.map(link.linkId, "home", selections);
  assert.deepEqual([...f.docs.entries()].filter(([key]) => key.startsWith("accounts/")), before, "retry must not reset opening balances or create duplicates");
});

test("interrupted account creation resumes its saved plan after reload", async () => {
  const f = fixture(); const link = await f.client.exchange("public-one", "home", "Bank");
  const selections = link.accounts.map(account => ({ providerAccountId: account.id, create: true }));
  f.fail((collection, body) => collection === "accounts" && body.external_id === "bank-b");
  await assert.rejects(f.client.map(link.linkId, "home", selections), /interrupted/);
  assert.equal(f.docs.has(`connections/${link.linkId}`), false);
  const [pending] = await f.client.pending("home");
  assert.equal(pending.mappings.length, 2);
  f.fail(null);
  await assert.rejects(f.client.map(link.linkId, "home", selections.slice(0, 1)), /different account mapping/);
  await f.client.map(link.linkId, "home", pending.mappings);
  assert.equal([...f.docs.values()].filter(doc => doc.body.connection_id === link.linkId).length, 2);
  assert.equal((await f.client.pending("home")).length, 0);
});

test("invalid creation requests make no accounts or mapping plan", async () => {
  const f = fixture(); const link = await f.client.exchange("public-one", "home", "Bank");
  const before = f.docs.size;
  for (const input of [
    [{ providerAccountId: "bank-a", create: true }, { providerAccountId: "bank-a", create: true }],
    [{ providerAccountId: "bank-a", create: true, accountId: "a" }],
    [{ providerAccountId: "unknown", create: true }],
    [{ providerAccountId: "bank-a", create: true }, { providerAccountId: "bank-b", accountId: "absent" }],
  ]) await assert.rejects(f.client.map(link.linkId, "home", input));
  f.providers[1].balances.current = null;
  await assert.rejects(f.client.map(link.linkId, "home", link.accounts.map(account => ({ providerAccountId: account.id, create: true }))), /current balance/);
  assert.equal(f.docs.size, before);
  assert.deepEqual(f.docs.get(`plaid_items/${link.linkId}`).body.mappings, []);
});

test("a bank still preparing history stays pending for hourly retry, not a successful daily sync", async () => {
  const f = fixture(); const link = await f.client.exchange("public-one", "home", "Bank");
  await f.client.map(link.linkId, "home", [{ providerAccountId: "bank-a", create: true }]);
  for (const status of ["NOT_READY", "INITIAL_UPDATE_COMPLETE"]) {
    f.pages.set("bank-a", [page([], { transactions_update_status: status })]);
    assert.equal((await f.client.sync(link.linkId, "home")).pending, true);
    assert.equal(f.docs.get(`connections/${link.linkId}`).body.last_sync_at, undefined);
  }
  assert.equal(f.calls.filter(call => call.path === "/transactions/sync").length, 2, "do not spin on an unfinished historical pull");
  f.pages.set("bank-a", [page([txn("bank-a", "history", 42)], { transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" })]);
  assert.equal((await f.client.sync(link.linkId, "home")).pending, false);
  assert.ok(f.docs.get(`connections/${link.linkId}`).body.last_sync_at);
});
