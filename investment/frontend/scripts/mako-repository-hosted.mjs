// Stages synthetic content only. Never publishes a portfolio head.
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
  const readHead = { action: 'read', kind: 'head', id: 'portfolio' };
  phase = 'access_control';
  for (const role of ['owner', 'foreign']) assert.equal((await invoke(role, readHead)).status, 403);
  assert.equal((await invoke(null, readHead)).status, 401);
  const absent = await invoke('worker', readHead);
  assert.equal(absent.status, 200);
  assert.equal(absent.body, null); // Refuse to stage against an already initialized app.
  passed('worker-only repository access and uninitialized head');
  const part = encode('p', { format: 1, table: 'accounts', bucket: 'qualification', rows: [{ id: 1, code: `qualification_${randomUUID()}`, name: null, account_type: null }] });
  const publicRoot = encode('m', { format: 1, visibility: 'public', children: [{ kind: 'partition', table: 'accounts', bucket: 'qualification', content: ref(part) }] });
  const privateRoot = encode('m', { format: 1, visibility: 'private', children: [] });
  phase = 'immutable_staging';
  for (const [kind, document] of [['public', part], ['public', publicRoot], ['private', privateRoot]]) {
    const response = await invoke('worker', { action: 'stage', kind, document });
    assert.equal(response.status, 200);
    assert.equal(response.body.id, document.id);
    report.staged.push({ kind, ...ref(document) });
  }
  const replay = await invoke('worker', { action: 'stage', kind: 'public', document: part });
  assert.equal(replay.status, 200);
  assert.ok(['replayed', 'reused'].includes(replay.body.status));
  passed('immutable content, verified manifests, and replay');
  phase = 'document_policies';
  const direct = (collection, id) => `${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/${collection}/documents/${id}`;
  const ownerRead = await fetch(direct('portfolio_public', part.id), { headers: headers('owner'), signal: AbortSignal.timeout(20000) });
  assert.equal(ownerRead.status, 200);
  assert.equal((await ownerRead.json()).body.payload, part.payload);
  for (const role of ['owner', 'worker', 'foreign']) {
    assert.equal((await fetch(direct('portfolio_private', privateRoot.id), { headers: headers(role), signal: AbortSignal.timeout(20000) })).status, 404);
  }
  for (const role of ['worker', 'foreign']) {
    assert.equal((await fetch(direct('portfolio_public', part.id), { headers: headers(role), signal: AbortSignal.timeout(20000) })).status, 404);
  }
  const forbidden = encode('p', { format: 1, table: 'accounts', bucket: 'qualification_forbidden', rows: [{ id: 2, code: 'forbidden', name: null, account_type: null }] });
  const mutationId = randomUUID();
  const ownerWrite = await fetch(direct('portfolio_public', forbidden.id), { method: 'POST', headers: { ...headers('owner'), 'Idempotency-Key': mutationId }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ mutationId, operation: 'create', expectedRevision: null, schemaVersion: 1, body: forbidden }) });
  assert.equal(ownerWrite.status, 403);
  passed('owner-only public reads and denial of direct/private writes');
  phase = 'incomplete_head_denial';
  const head = { id: 'portfolio', format: 1, sequence: 1, public_root: ref(publicRoot), private_root: ref(privateRoot),
    command: { id: `c_${'0'.repeat(64)}`, bytes: 1 }, next_ids: { account: 2, ticker: 1, transaction: 1, brokerage_user: 1 } };
  assert.equal((await invoke('worker', { action: 'commit', expectedRevision: null, head })).status, 409);
  assert.equal((await invoke('worker', readHead)).body, null);
  passed('missing command blocks publication; head remains absent');
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
