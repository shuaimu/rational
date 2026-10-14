import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cacheAction } from '../../mako/functions/repository/cache.js';

const row = { symbol: 'FIXTURE', price_date: '2025-01-02', price: 123.45, source: 'fixture', fetched_at: null, is_market_close: true };
const body = { id: `r_${createHash('sha256').update(JSON.stringify([row.symbol,row.price_date])).digest('hex')}`, row };
const create = { action: 'cache_mutate', kind: 'historical_prices', mutationId: 'fixture_cache_0001', operation: 'create', expectedRevision: null, body };

test('cache rejects arbitrary collections, unindexed queries, private fields and wrong keys', async () => {
  const documents = () => { throw new Error('must not call storage'); };
  for (const input of [
    { ...create, kind: 'portfolio_private' },
    { ...create, body: { ...body, id: `r_${'0'.repeat(64)}` } },
    { ...create, body: { ...body, row: { ...row, user_secret: 'forbidden' } } },
    { action: 'cache_query', kind: 'historical_prices', query: { predicates: [] } },
  ]) await assert.rejects(cacheAction(input, documents), { status: 400 });
});
test('symbol/date queries always use the declared composite index and bounded page', async () => {
  const result = await cacheAction({ action: 'cache_query', kind: 'historical_prices', query: { index: 'symbol', value: 'FIXTURE', from: '2025-01-01', through: '2025-02-01', cursor: null, limit: 500 } }, () => ({ query: async (query) => query }));
  assert.deepEqual(result.sort, [{ field: 'row.price_date', direction: 'asc' }, { field: 'id', direction: 'asc' }]);
  assert.equal(result.predicates.length, 3);
  assert.equal(result.limit, 500);
});
test('cleared cache record restores against the tombstone revision; live conflicts never overwrite', async () => {
  for (const live of [true, false]) {
    const mutations = [];
    const result = await cacheAction(create, () => ({ get: async () => live ? { body } : null, mutate: async (_, mutation) => {
      mutations.push(mutation);
      return mutations.length === 1 ? { status: 'conflict', currentRevision: 'r_tombstone' } : { status: 'applied' };
    } }));
    assert.equal(mutations.length, live ? 1 : 2);
    assert.equal(result.status, live ? 'conflict' : 'applied');
    if (!live) { assert.equal(mutations[1].operation, 'update'); assert.equal(mutations[1].expectedRevision, 'r_tombstone'); assert.notEqual(mutations[0].mutationId, mutations[1].mutationId); }
  }
});
test('usage logs cannot be updated or deleted through cache administration', async () => {
  for (const operation of ['update','delete']) await assert.rejects(cacheAction({ ...create, kind: 'provider_requests', operation }, () => { throw new Error('no storage access'); }), { status: 400 });
});

const logRecords = Array.from({ length: 8 }, (_, index) => ({
  mutationId: `fixture_log_batch_${index}`,
  body: {
    id: `r_${createHash('sha256').update(JSON.stringify([index + 1])).digest('hex')}`,
    row: { id: index + 1, provider: 'fixture', endpoint: 'fixture', success: true, status_code: 200, error: null, requested_at: null },
  },
}));
const batch = { action: 'cache_create_batch', kind: 'provider_requests', records: logRecords };

test('append batches validate every record and bound the batch before any write', async () => {
  const storage = () => { throw new Error('must not reach storage'); };
  for (const input of [
    { ...batch, kind: 'historical_prices' },
    { ...batch, records: [] },
    { ...batch, records: Array.from({ length: 17 }, () => logRecords[0]) },
    { ...batch, records: [logRecords[0], logRecords[0]] },
    { ...batch, records: [logRecords[0], { ...logRecords[1], mutationId: logRecords[0].mutationId }] },
    { ...batch, records: [...logRecords.slice(0, -1), { ...logRecords[7], body: { ...logRecords[7].body, row: { ...logRecords[7].body.row, error: 'private remote error text' } } }] },
  ]) await assert.rejects(cacheAction(input, storage), { status: 400 });
});

test('append batches use create-only writes and settle started writes before a failure returns', async () => {
  const pending = [];
  let started;
  const firstGroup = new Promise((resolve) => { started = resolve; });
  const storage = () => ({ mutate: (id, mutation) => {
    assert.equal(mutation.operation, 'create');
    assert.equal(mutation.expectedRevision, null);
    assert.equal(mutation.schemaVersion, 1);
    assert.equal(mutation.body.id, id);
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (pending.length === 4) started();
    });
  } });
  let returned = false;
  const operation = cacheAction(batch, storage).finally(() => { returned = true; });
  const rejected = assert.rejects(operation, /storage unavailable/);
  await firstGroup;
  pending[0].reject(new Error('storage unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  for (const item of pending.slice(1)) item.resolve({ status: 'applied' });
  await rejected;
  assert.equal(pending.length, 4, 'must not start another group after failure');
});

test('append batches preserve record order, durable mutation IDs, and replay results', async () => {
  const saved = new Map();
  const storage = () => ({ mutate: async (id, mutation) => {
    const prior = saved.get(id);
    if (prior) assert.deepEqual(mutation, prior);
    saved.set(id, mutation);
    return { status: prior ? 'replayed' : 'applied', document: { body: mutation.body } };
  } });
  for (const expected of ['applied', 'replayed']) {
    const result = await cacheAction(batch, storage);
    assert.deepEqual(result.results.map((row) => row.id), logRecords.map((row) => row.body.id));
    assert.ok(result.results.every((row) => row.result.status === expected));
  }
});
