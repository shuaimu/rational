import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecords, StageError } from '../../frontend/scripts/mako-stage-helpers.mjs';

const rows = [1, 2, 3, 4].map((id) => ({ id: `fixture_${id}`, row: { id } }));
const document = (body) => ({ body, schemaVersion: 1, _deleted: false });
test('ambiguous batch commits reconcile exact rows and retry only missing records with stable IDs', async () => {
  const stored = new Map(), batches = [], delays = [];
  const call = async (input) => {
    if (input.action === 'cache_read') return stored.get(input.id) ?? null;
    batches.push(input.records);
    const selected = batches.length === 1 ? input.records.slice(0, 2) : input.records;
    for (const item of selected) stored.set(item.body.id, document(item.body));
    if (batches.length === 1) throw new StageError('gateway_request_failed', 503);
    return { results: input.records.map((item) => ({ id: item.body.id, result: { status: 'applied', document: stored.get(item.body.id) } })) };
  };
  assert.equal(await createRecords('provider_requests', rows, call, async (ms) => delays.push(ms)), 4);
  assert.deepEqual(batches[1], batches[0].slice(2));
  assert.equal(stored.size, 4);
  assert.deepEqual(delays, [1000]);
});
test('lost response after every row commits requires no second write', async () => {
  let writes = 0;
  const call = async (input) => {
    if (input.action === 'cache_read') return document(rows.find((row) => row.id === input.id));
    writes++; throw new StageError('gateway_request_failed', 503);
  };
  assert.equal(await createRecords('provider_requests', rows, call, async () => {}), 4);
  assert.equal(writes, 1);
});
test('conflicting content and permanent denial stop without overwriting or retrying', async () => {
  for (const status of [409, 403]) {
    let writes = 0;
    const call = async (input) => {
      if (input.action === 'cache_read') return document({ ...rows[0], row: { id: 99 } });
      writes++; throw new StageError('gateway_request_failed', status);
    };
    await assert.rejects(createRecords('provider_requests', rows, call, async () => {}), (error) => error.code === (status === 409 ? 'destination_collision' : 'gateway_request_failed'));
    assert.equal(writes, 1);
  }
});
