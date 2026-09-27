// Exercises only explicit synthetic cache keys. Never publishes a portfolio head.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakoAuthClient, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { identities: { type: 'string' }, 'public-key': { type: 'string' }, report: { type: 'string' }, 'allow-synthetic-staging': { type: 'boolean' } } });
if (!values.identities || !values['public-key'] || !values.report || !values['allow-synthetic-staging']) throw new Error('Required: --identities --public-key --report --allow-synthetic-staging');
const report = { format: 1, complete: false, cutoverReady: false, headPublished: false, results: [], staged: [] };
const auths = new Map(), sessions = new Map();
let reserved = false, phase = 'configuration';
const passed = (name) => { report.results.push({ name, passed: true }); console.log(`Passed: ${name}`); };
const encode = (prefix, value) => { const payload = JSON.stringify(value); return { id: `${prefix}_${createHash('sha256').update(payload).digest('hex')}`, payload }; };
const ref = (doc) => ({ id: doc.id, bytes: Buffer.byteLength(doc.payload) });
try {
  await writeFile(values.report, '', { mode: 0o600, flag: 'wx' }); reserved = true;
  assert.equal((await stat(values.identities)).mode & 0o077, 0);
  const config = JSON.parse(await readFile(resolve(root, 'mako/environment.json'), 'utf8'));
  assert.equal(config.endpoint, 'https://cloud-test.makodb.com');
  assert.equal(config.projectId, 'prj_43f3756d4588d7412cbe0b633a455695');
  assert.equal(config.environmentId, 'env_833a71a6da540180b4e64c05cfb90e6d');
  const key = (await readFile(values['public-key'], 'utf8')).trim();
  const identities = JSON.parse(await readFile(values.identities, 'utf8'));
  const normalized = normalizeMakoRxdbConfig({ ...config, publicProjectKey: key, collectionId: 'portfolio_heads', schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'node' });
  for (const role of ['owner', 'worker', 'foreign']) {
    phase = `${role}_signin`;
    const auth = new MakoAuthClient(normalized, { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20000) }) });
    auths.set(role, auth);
    const session = await auth.signInWithPassword(identities[role].email, identities[role].password);
    assert.equal(session.user.id, identities[role].session.user.id);
    sessions.set(role, session);
  }
  const headers = (role) => ({ 'Content-Type': 'application/json', 'X-Mako-Key': key,
    ...(role ? { Authorization: `Bearer ${sessions.get(role).accessToken}` } : {}) });
  const url = `${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-repository`;
  const invoke = async (role, input) => {
    const response = await fetch(url, { method: 'POST', headers: headers(role), body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const query = async (kind, index, value = null, from = null, through = null, cursor = null, limit = 1) => invoke('worker', { action: 'cache_query', kind, query: { index, value, from, through, cursor, limit } });
  const symbol = 'ROBINLAB_QUALIFICATION_20260924';
  const docs = [1,2,3].map((day) => {
    const row = { symbol, price_date: `2025-01-0${day}`, price: day * 12.5, source: 'qualification', fetched_at: '2026-09-24 00:00:00', is_market_close: true };
    return { id: `r_${createHash('sha256').update(JSON.stringify([symbol,row.price_date])).digest('hex')}`, row };
  });
  const mutate = (body, operation, expectedRevision = null) => invoke('worker', { action: 'cache_mutate', kind: 'historical_prices', mutationId: `qualification_${randomUUID()}`, operation, expectedRevision, body });
  phase = 'cache_staging';
  for (const body of docs) {
    const prior = await invoke('worker', {action:'cache_read',kind:'historical_prices',id:body.id});
    assert.equal(prior.status,200);
    if (prior.body) assert.deepEqual(prior.body.body,body);
    const result = prior.body ? {status:200,body:{document:prior.body}} : await mutate(body, 'create');
    assert.equal(result.status, 200);
    assert.equal(result.body.document.body.id, body.id);
    report.staged.push({ kind: 'historical_prices', id: body.id });
  }
  passed('bounded cache records and compound identities');
  phase = 'indexed_pagination';
  const ids = new Set(); let cursor = null;
  do {
    const result = await query('historical_prices', 'symbol', symbol, '2025-01-01', '2025-01-03', cursor);
    assert.equal(result.status, 200);
    assert.equal(result.body.documents.length, 1);
    const id = result.body.documents[0].body.id;
    assert.equal(ids.has(id), false); ids.add(id);
    cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 3);
  for (const index of ['all', 'date']) {
    const result = index === 'all' ? await query('historical_prices', index) : await query('historical_prices', index, null, '2025-01-01', '2025-01-03');
    assert.equal(result.status, 200);
    assert.ok(result.body.documents.length > 0);
  }
  for (const kind of ['latest_prices','provider_requests','split_fetch']) assert.equal((await query(kind, 'all')).status, 200);
  passed('declared indexes, signed cursors, and complete paginated reads');
  phase = 'cache_policies';
  const direct = `${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/historical_prices/documents/${docs[0].id}`;
  for (const role of ['owner', 'foreign', 'worker']) {
    const response = await fetch(direct, { headers: headers(role), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, role === 'owner' ? 200 : 404);
  }
  assert.equal((await invoke('owner', {action:'cache_read',kind:'historical_prices',id:docs[0].id})).status,403);
  passed('owner public reads and worker-only mutation gateway');
  phase = 'delete_restore';
  let current = await invoke('worker', { action:'cache_read',kind:'historical_prices',id:docs[0].id });
  assert.equal((await mutate(docs[0], 'delete', current.body.revision)).status,200);
  assert.equal((await invoke('worker',{action:'cache_read',kind:'historical_prices',id:docs[0].id})).body,null);
  assert.equal((await mutate(docs[0], 'create')).status,200);
  passed('deleted cache record safely refetched through tombstone CAS');
  phase = 'synthetic_cleanup';
  for (const body of docs) {
    current = await invoke('worker', { action:'cache_read',kind:'historical_prices',id:body.id });
    assert.equal((await mutate(body, 'delete', current.body.revision)).status,200);
  }
  const remaining = await query('historical_prices','symbol',symbol,'2025-01-01','2025-01-03');
  assert.equal(remaining.status,200); assert.equal(remaining.body.documents.length,0);
  report.syntheticLiveRecords = 0;
  passed('synthetic cleanup leaves only recorded tombstones');
  report.complete = true;
} catch (error) {
  report.failure = { phase, type: error.name, ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(Number.isInteger(error.actual) ? { actualStatus: error.actual } : {}), ...(Number.isInteger(error.expected) ? { expectedStatus: error.expected } : {}) };
  console.error(`Repository qualification stopped during ${phase}; no head was published.`);
  process.exitCode = 1;
} finally {
  for (const auth of auths.values()) { try { await auth.signOut(); } catch { /* Retain original outcome. */ } }
  if (reserved) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
