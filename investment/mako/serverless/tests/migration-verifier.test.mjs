import test from 'node:test';
import assert from 'node:assert/strict';
import {InputVerifier, canonical, digest} from '../migration/verify-inputs.js';
import {freshDocuments} from '../migration/request-documents.js';

test('every read and checkpoint write gets a distinct service audit request identity', async () => {
  const seen = new Set(); let created = 0;
  const documents = freshDocuments(() => {
    const identity = ++created;
    const record = async () => {assert.ok(!seen.has(identity), 'audit identity reused'); seen.add(identity);};
    return {documents: name => {assert.equal(name, 'checkpoint'); return {get: record, query: record, mutate: record};}};
  }, 'checkpoint');
  await documents.get('state'); await documents.mutate('state', {});
  await documents.query({}); await documents.mutate('state', {});
  assert.equal(seen.size, 4);
});

async function fixture(count = 9) {
  const head = {id: 'portfolio', sequence: 249};
  const rows = Array.from({length: count}, (_, i) => ({schemaVersion: 1, body: {
    id: `a_${String(i).padStart(4, '0')}`, jobId: 'j_0000', payload: {one: 1, two: [2, 3]},
  }}));
  let stored = null, revision = 0, now = 1000, lost = false, reads = 0;
  const query = values => async ({cursor, limit, predicates, sort}) => {
    assert.deepEqual(predicates, [{field: 'jobId', operator: 'gte', value: ''}], 'SDK requires an indexed predicate');
    assert.deepEqual(sort, [{field: 'jobId', direction: 'asc'}, {field: 'id', direction: 'asc'}]);
    reads++; const offset = cursor === null ? 0 : Number(cursor);
    return {documents: structuredClone(values.slice(offset, offset + limit)), nextCursor: offset + limit < values.length ? String(offset + limit) : null};
  };
  const source = {head: {get: async () => ({body: head})}, inputs: {query: query(rows)}};
  const target = structuredClone(rows);
  const destination = {head: {get: async () => null}, inputs: {query: query(target)}};
  const journal = {
    get: async () => structuredClone(stored),
    mutate: async (_id, request) => {
      if (request.expectedRevision !== (stored?.revision ?? null)) return {status: 'conflict'};
      stored = {body: structuredClone(request.body), revision: String(++revision)};
      if (lost && request.body.verifiedCount === 4) {lost = false; throw new TypeError('fetch failed');}
      return {status: 'applied', document: structuredClone(stored)};
    },
  };
  const plan = {id: 'test', projectId: 'project', sourceEnvironment: 'source', destinationEnvironment: 'destination',
    collection: 'robinlab_inputs', count, headId: 'portfolio', sourceHeadDigest: await digest(canonical(head)),
    sourceVerificationDigest: 'a'.repeat(64), otherCollectionsVerified: 13, nativeReportsVerified: 9};
  return {source, destination, journal, plan, rows, target, head,
    verifier: options => new InputVerifier({source, destination, journal, plan, clock: () => now, maxPages: 1, pageSize: 4, ...options}),
    advance: () => {now += 60000;}, loseCheckpointReply: () => {lost = true;}, state: () => stored?.body, reads: () => reads};
}

test('bounded scheduled invocations resume cursors and verify exact complete collection', async () => {
  const f = await fixture();
  assert.equal((await f.verifier().run('run1')).verifiedCount, 4);
  assert.equal(f.state().leaseUntil, 0);
  assert.equal((await f.verifier().run('run2')).verifiedCount, 8);
  assert.equal((await f.verifier().run('run3')).status, 'verified');
  assert.equal(f.state().verifiedCount, 9);
  const reads = f.reads(); await f.verifier().run('run4'); assert.equal(f.reads(), reads);
});

test('lost checkpoint response resumes the durable cursor without counting twice', async () => {
  const f = await fixture(); f.loseCheckpointReply();
  assert.equal((await f.verifier().run('run1')).status, 'lease-lost');
  assert.equal(f.state().verifiedCount, 4);
  await f.verifier().run('overlap'); assert.equal(f.reads(), 2);
  f.advance(); await f.verifier().run('run2'); await f.verifier().run('run3');
  assert.equal(f.state().status, 'verified'); assert.equal(f.state().verifiedCount, 9);
});

test('concurrent scheduler invocations have one checkpoint owner', async () => {
  const f = await fixture();
  await Promise.all([f.verifier().run('run1'), f.verifier().run('run2')]);
  assert.equal(f.state().verifiedCount, 4); assert.equal(f.reads(), 2);
});

test('mismatched payload blocks durably without exposing its contents', async () => {
  const f = await fixture(); f.target[2].body.payload = {secret: 'private-financial-value'};
  const state = await f.verifier().run('run1');
  assert.equal(state.status, 'blocked'); assert.equal(state.reason, 'document_mismatch');
  assert.equal(state.verifiedCount, 0); assert.ok(!JSON.stringify(state).includes('private-financial-value'));
  const reads = f.reads(); await f.verifier().run('run2'); assert.equal(f.reads(), reads);
});

test('missing rows, extra rows and stalled cursors cannot produce a verification receipt', async () => {
  for (const mode of ['missing', 'extra', 'stalled']) {
    const f = await fixture();
    if (mode === 'missing') f.target.pop();
    if (mode === 'extra') {f.rows.push({...f.rows[8], body: {...f.rows[8].body, id: 'a_9999'}}); f.target.push(structuredClone(f.rows[9]));}
    if (mode === 'stalled') {
      const query = f.source.inputs.query;
      f.source.inputs.query = async input => ({...await query(input), nextCursor: '4'});
    }
    for (let i = 0; i < 4; i++) await f.verifier().run('run' + i);
    assert.equal(f.state().status, 'blocked', mode);
  }
});

test('source head change and premature destination publication stop the verifier', async () => {
  for (const side of ['source', 'destination']) {
    const f = await fixture();
    if (side === 'source') f.head.sequence++;
    else f.destination.head.get = async () => ({body: f.head});
    await f.verifier().run('run'); assert.equal(f.state().status, 'blocked'); assert.equal(f.reads(), 0);
  }
});

test('transient service errors retry the same cursor; authorization failure blocks', async () => {
  const f = await fixture(); const query = f.destination.inputs.query;
  f.destination.inputs.query = async () => {throw Object.assign(new Error('private response'), {status: 503});};
  assert.equal((await f.verifier().run('run1')).status, 'retry'); assert.equal(f.state().verifiedCount, 0);
  f.destination.inputs.query = query;
  assert.equal((await f.verifier().run('run2')).verifiedCount, 4);
  f.destination.inputs.query = async () => {throw Object.assign(new Error('private response'), {status: 403});};
  assert.equal((await f.verifier().run('run3')).status, 'blocked'); assert.equal(f.state().verifiedCount, 4);
});

test('journal cannot be reused for another plan or without prior source proof', async () => {
  const f = await fixture(); await f.verifier().run('run1'); f.plan.count++;
  await assert.rejects(() => f.verifier().run('run2'), /journal_plan_changed/);
  f.plan.nativeReportsVerified = 0; assert.throws(() => f.verifier(), /missing_prior_parity/);
});

test('SDK transport outages retry, while SDK validation errors fail closed', async () => {
  for (const [message, expected] of [['Mako service is unavailable', 'retry'], ['document query needs at least one predicate', 'blocked']]) {
    const f = await fixture();
    f.destination.inputs.query = async () => {throw Object.assign(new Error(message), {name: 'MakoEdgeSdkError'});};
    assert.equal((await f.verifier().run('run')).status, expected);
    assert.equal(f.state().verifiedCount, 0);
  }
});

// Production batches bound both response memory and the work before a durable checkpoint.
test('production page size advances a full bounded batch and resumes its tail', async () => {
  const f = await fixture(35);
  assert.equal((await f.verifier({pageSize: undefined}).run('run1')).verifiedCount, 32);
  assert.equal((await f.verifier({pageSize: undefined}).run('run2')).status, 'verified');
  assert.equal(f.state().verifiedCount, 35);
  assert.throws(() => f.verifier({pageSize: 33}), /invalid_page_size/);
});
