import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualificationHandler } from '../../mako/functions/qualify/handler.js';

function setup(user = { id: 'worker', status: 'active' }) {
  const calls = [];
  let outcome = 'applied';
  const parts = new Map();
  const handler = createQualificationHandler({
    workerId: 'worker', authenticate: async () => user,
    documentClient: (collection) => {
      calls.push({ client: collection });
      return {
        async get(id) { calls.push({ read: id }); return parts.get(id) ?? null; },
        async mutate(id, mutation) { calls.push({ write: id, mutation }); return { status: outcome, mutationId: mutation.mutationId }; },
      };
    },
  });
  return { calls, parts, handler, setOutcome: (status) => { outcome = status; } };
}
const request = (body) => new Request('https://fixture.test/qualify', { method: 'POST', body: JSON.stringify(body) });
const commit = { action: 'commit', id: 'q_head', mutationId: 'qualification-commit-1', expectedRevision: 'revision-1', partIds: ['q_a', 'q_b'], value: 2 };

test('owner and disabled worker cannot reach privileged data', async () => {
  for (const user of [{ id: 'owner', status: 'active' }, { id: 'worker', status: 'disabled' }]) {
    const f = setup(user);
    assert.equal((await f.handler(request(commit))).status, 403);
    assert.deepEqual(f.calls, []);
  }
});
test('incomplete manifests never publish a head', async () => {
  const f = setup();
  f.parts.set('q_a', { _deleted: false, body: { id: 'q_a' } });
  const response = await f.handler(request(commit));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'incomplete_manifest');
  assert.equal(f.calls.filter((call) => call.write).length, 0);
});
test('all parts precede one conditional head publication', async () => {
  const f = setup();
  for (const id of commit.partIds) f.parts.set(id, { _deleted: false, body: { id } });
  const response = await f.handler(request(commit));
  assert.equal(response.status, 200);
  const operations = f.calls.filter((call) => call.read || call.write);
  assert.deepEqual(operations.map((call) => call.read ?? call.write), ['q_a', 'q_b', 'q_head']);
  assert.equal(operations[2].mutation.expectedRevision, 'revision-1');
  assert.equal(operations[2].mutation.mutationId, commit.mutationId);
  assert.equal(f.calls.filter((call) => call.client).length, 3);
});
test('stale head conflict is returned to the caller', async () => {
  const f = setup();
  for (const id of commit.partIds) f.parts.set(id, { _deleted: false, body: { id } });
  f.setOutcome('conflict');
  assert.equal((await f.handler(request(commit))).status, 409);
});
test('staging is create-only and cannot choose an arbitrary collection', async () => {
  const f = setup();
  const stage = { action: 'stage', id: 'q_part', mutationId: 'qualification-stage-1', payload: 'synthetic' };
  assert.equal((await f.handler(request(stage))).status, 200);
  const mutation = f.calls.find((call) => call.write).mutation;
  assert.equal(mutation.expectedRevision, null);
  assert.equal(mutation.operation, 'create');
  assert.equal((await f.handler(request({ ...stage, collection: 'snaptrade_users' }))).status, 400);
});
test('deleted parts and invalid part lists cannot be committed', async () => {
  const f = setup();
  f.parts.set('q_a', { _deleted: true, body: { id: 'q_a' } });
  assert.equal((await f.handler(request({ ...commit, partIds: ['q_a'] }))).status, 409);
  for (const partIds of [[], ['q_a', 'q_a'], ['../private']]) {
    assert.equal((await f.handler(request({ ...commit, partIds }))).status, 400);
  }
  assert.equal(f.calls.filter((call) => call.write).length, 0);
});
test('backend errors do not leak secrets', async () => {
  const handler = createQualificationHandler({ workerId: 'worker',
    authenticate: async () => { throw new Error('private_token'); },
    documentClient: () => { throw new Error('must not run'); } });
  const response = await handler(request(commit));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"unavailable"}');
});

test('changed content under an existing mutation ID remains a non-retryable conflict', async () => {
  const handler = createQualificationHandler({ workerId: 'worker',
    authenticate: async () => ({ id: 'worker', status: 'active' }),
    documentClient: () => ({ mutate: async () => {
      throw Object.assign(new Error('private upstream detail'), { status: 409, code: 'conflict' });
    } }),
  });
  const response = await handler(request({ action: 'stage', id: 'q_part',
    mutationId: 'existing-mutation-id', payload: 'changed' }));
  assert.equal(response.status, 409);
  assert.equal(await response.text(), '{"error":"conflict"}');
});

test('large staging enforces a byte bound before persistence', async () => {
  const f = setup();
  const input = { action: 'stageLarge', id: 'q_large', mutationId: 'qualification-large-1', payload: 'x'.repeat(32768) };
  assert.equal((await f.handler(request(input))).status, 200);
  assert.equal(f.calls.find((call) => call.client).client, 'qualification_large_parts');
  const before = f.calls.length;
  for (const payload of ['x'.repeat(32769), '🦅'.repeat(8193)]) {
    assert.equal((await f.handler(request({ ...input, payload }))).status, 400);
  }
  assert.equal(f.calls.length, before);
});

test('upstream diagnostics expose only fixed reasons and HTTP status', async () => {
  const make = (message) => createQualificationHandler({ workerId: 'worker',
    authenticate: async () => { throw Object.assign(new Error(message), { status: 503 }); },
    documentClient: () => { throw new Error('must not run'); } });
  const publicError = await make('document sequencer is unavailable')(request(commit));
  assert.deepEqual(await publicError.json(), { error: 'unavailable', upstreamStatus: 503,
    upstreamReason: 'document sequencer is unavailable' });
  const privateError = await make('private_token')(request(commit));
  assert.deepEqual(await privateError.json(), { error: 'unavailable', upstreamStatus: 503 });
});
