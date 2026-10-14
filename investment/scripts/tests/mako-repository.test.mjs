import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRepositoryHandler } from '../../mako/functions/repository/handler.js';

const encode = (prefix, value) => {
  const payload = JSON.stringify(value);
  return { id: `${prefix}_${createHash('sha256').update(payload).digest('hex')}`, payload };
};
const ref = (doc) => ({ id: doc.id, bytes: Buffer.byteLength(doc.payload) });
const account = { id: 1, code: 'fixture', name: null, account_type: null };
const partition = (rows = [account], table = 'accounts') => encode('p', { format: 1, table, bucket: 'id_0', rows });

function fixture(user = { id: 'worker', status: 'active' }) {
  const records = new Map();
  const calls = [];
  let revision = 0;
  const handler = createRepositoryHandler({ workerId: 'worker', authenticate: async () => user,
    documents: (collection) => ({
      get: async (id) => { calls.push(['read', collection, id]); return records.get(`${collection}/${id}`) ?? null; },
      mutate: async (id, input) => {
        calls.push(['mutate', collection, id]);
        const key = `${collection}/${id}`;
        const prior = records.get(key);
        if ((prior?.revision ?? null) !== input.expectedRevision) return { status: 'conflict' };
        const document = { primaryKey: id, schemaVersion: 1, _deleted: false, revision: `r_${++revision}`, body: input.body };
        records.set(key, document);
        return { status: 'applied', document };
      },
    }),
  });
  const call = async (body) => {
    const response = await handler(new Request('https://fixture.test/repository', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const stage = (kind, document) => call({ action: 'stage', kind, document });
  return { records, calls, call, stage };
}

async function prepare(f, identity = 'fixture_command_1') {
  const part = partition();
  assert.equal((await f.stage('public', part)).status, 200);
  const publicRoot = encode('m', { format: 1, visibility: 'public', children: [{ kind: 'partition', table: 'accounts', bucket: 'id_0', content: ref(part) }] });
  const privateRoot = encode('m', { format: 1, visibility: 'private', children: [] });
  assert.equal((await f.stage('public', publicRoot)).status, 200);
  assert.equal((await f.stage('private', privateRoot)).status, 200);
  const next_ids = { account: 2, ticker: 1, transaction: 1, brokerage_user: 1 };
  const command = encode('c', { format: 1, identity: { id: identity, request_hash: 'a'.repeat(64) }, sequence: 1,
    predecessor: null, public_root: ref(publicRoot), private_root: ref(privateRoot), next_ids, response: { id: 1 } });
  assert.equal((await f.stage('command', command)).status, 200);
  return { action: 'commit', expectedRevision: null, head: { id: 'portfolio', format: 1, sequence: 1,
    public_root: ref(publicRoot), private_root: ref(privateRoot), command: ref(command), next_ids } };
}

test('owner, unrelated and disabled worker cannot read or stage', async () => {
  for (const user of [{ id: 'owner', status: 'active' }, { id: 'other', status: 'active' }, { id: 'worker', status: 'disabled' }]) {
    const f = fixture(user);
    assert.equal((await f.stage('public', partition())).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test('corrupt content and private fields cannot be staged publicly', async () => {
  const f = fixture();
  const part = partition();
  assert.equal((await f.stage('public', { ...part, payload: part.payload + ' ' })).status, 409);
  assert.equal((await f.stage('public', partition([{ ...account, user_secret: 'fixture_secret' }]))).status, 400);
  assert.equal((await f.stage('public', partition([{ id: 1, user_secret: 'fixture_secret' }], 'snaptrade_users'))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('missing child and branch crossing cannot create a manifest', async () => {
  const f = fixture();
  const part = partition();
  const manifest = encode('m', { format: 1, visibility: 'public', children: [{ kind: 'partition', table: 'accounts', bucket: 'id_0', content: ref(part) }] });
  assert.equal((await f.stage('public', manifest)).status, 409);
  assert.equal((await f.stage('private', manifest)).status, 400);
  assert.equal(f.calls.filter(([op]) => op === 'mutate').length, 0);
});

test('immutable duplicate can be reused after receipt expiry', async () => {
  const f = fixture();
  assert.equal((await f.stage('public', partition())).body.status, 'applied');
  assert.equal((await f.stage('public', partition())).body.status, 'reused');
  assert.equal(f.records.size, 1);
});

test('two prepared publications have exactly one winner', async () => {
  const f = fixture();
  const first = await prepare(f, 'fixture_command_1');
  const second = await prepare(f, 'fixture_command_2');
  assert.equal(f.records.has('portfolio_heads/portfolio'), false);
  const outcomes = await Promise.all([f.call(first), f.call(second)]);
  assert.deepEqual(outcomes.map((result) => result.status).sort(), [200, 409]);
  const head = f.records.get('portfolio_heads/portfolio').body;
  const history = f.records.get(`portfolio_commands/${head.command.id}`).body;
  assert.equal(JSON.parse(history.payload).response.id, 1);
});

test('head must match the staged command and its predecessor', async () => {
  const f = fixture();
  const input = await prepare(f);
  const changed = structuredClone(input);
  changed.head.next_ids.account = 99;
  assert.equal((await f.call(changed)).status, 409);
  assert.equal(f.records.has('portfolio_heads/portfolio'), false);
  assert.equal((await f.call(input)).status, 200);
  assert.equal((await f.call(input)).status, 409);
});

test('request validation rejects malformed document identifiers without writes', async () => {
  const f = fixture();
  assert.equal((await f.stage('public', { id: 1, payload: '{}' })).status, 400);
  assert.equal((await f.call({ action: 'read', kind: 'private', id: '../credentials' })).status, 400);
  assert.equal((await f.stage('public', encode('m', { format: 1, visibility: 'public', children: [null] }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('upstream diagnostics expose only closed codes and known availability reasons', async () => {
  for (const error of [
    Object.assign(new Error('document sequencer is unavailable'), { status: 503, code: 'unavailable' }),
    Object.assign(new Error('private_token document contents'), { status: 700, code: 'private_token' }),
  ]) {
    const handler = createRepositoryHandler({ workerId: 'worker', authenticate: async () => ({ id: 'worker', status: 'active' }), documents: () => ({ get: async () => { throw error; } }) });
    const response = await handler(new Request('https://fixture.test', { method: 'POST', body: JSON.stringify({ action: 'read', kind: 'head', id: 'portfolio' }) }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), error.status === 503
      ? { error: 'unavailable', retryAfterMs: 1000, upstreamStatus: 503, upstreamCode: 'unavailable', upstreamReason: 'document sequencer is unavailable' }
      : { error: 'unavailable', retryAfterMs: 1000 });
  }
});
