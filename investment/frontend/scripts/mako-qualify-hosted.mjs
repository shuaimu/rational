// Runs only synthetic q_ writes in the explicitly selected qualification environment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakoAuthClient, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: {
  identities: { type: 'string' }, 'public-key': { type: 'string' },
  report: { type: 'string' }, 'allow-synthetic-writes': { type: 'boolean' },
  benchmark: { type: 'boolean' },
} });
if (!values.identities || !values['public-key'] || !values.report || !values['allow-synthetic-writes']) {
  console.error('Required: --identities <private JSON> --public-key <file> --report <new file> --allow-synthetic-writes');
  process.exit(1);
}
const results = [];
let phase = 'configuration';
let config;
const sessions = new Map();
const report = { format: 1, startedAt: new Date().toISOString(), complete: false, cutoverReady: false, results };
const check = (name) => { results.push({ name, passed: true }); console.log(`Passed: ${name}`); };
const auths = new Map();
let reportReserved = false;
try {
  // Reserve the report before any write. Refuse accidental overwrites and public credentials.
  await writeFile(values.report, '', { flag: 'wx', mode: 0o600 });
  reportReserved = true;
  assert.equal((await stat(values.identities)).mode & 0o077, 0);
  config = JSON.parse(await readFile(resolve(root, 'mako/environment.json'), 'utf8'));
  assert.equal(config.environmentName, 'robinlab');
  assert.equal(config.projectId, 'prj_43f3756d4588d7412cbe0b633a455695');
  assert.equal(config.environmentId, 'env_833a71a6da540180b4e64c05cfb90e6d');
  assert.equal(config.endpoint, 'https://cloud-test.makodb.com');
  report.environmentId = config.environmentId;
  const publicKey = (await readFile(values['public-key'], 'utf8')).trim();
  const identities = JSON.parse(await readFile(values.identities, 'utf8'));
  const normalized = normalizeMakoRxdbConfig({ ...config, publicProjectKey: publicKey,
    collectionId: 'qualification_heads', schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'node' });
  for (const role of ['owner', 'worker', 'foreign']) {
    phase = `${role}_signin`;
    const auth = new MakoAuthClient(normalized, {
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
    });
    auths.set(role, auth);
    const identity = identities[role];
    const session = await auth.signInWithPassword(identity.email, identity.password);
    assert.equal(session.user.id, identity.session.user.id);
    assert.equal(session.user.status, 'active');
    sessions.set(role, session);
  }
  assert.equal(new Set([...sessions.values()].map((s) => s.user.id)).size, 3);
  check('distinct active application identities');
  const url = `${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-qualify`;
  const invoke = async (role, input, token = sessions.get(role)?.accessToken) => {
    const started = performance.now();
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Mako-Key': publicKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, cacheControl: response.headers.get('cache-control'),
      milliseconds: Math.round(performance.now() - started) };
  };
  const run = `q_${randomUUID().replaceAll('-', '')}`;
  const head = `${run}_head`;
  const part = `${run}_part`;
  const read = { action: 'read', kind: 'head', id: head };
  phase = 'authorization_denial';
  for (const role of ['owner', 'foreign']) {
    assert.equal((await invoke(role, read)).status, 403);
  }
  assert.equal((await invoke(null, read)).status, 401);
  check('owner, foreign identity, and anonymous caller denied');
  phase = 'worker_read';
  const absent = await invoke('worker', read);
  assert.equal(absent.status, 200);
  assert.equal(absent.body, null);
  assert.equal(absent.cacheControl, 'no-store');
  check('worker can read synthetic collection');
  phase = 'stage_and_replay';
  const stage = { action: 'stage', id: part, mutationId: randomUUID(), payload: 'synthetic'.repeat(400) };
  const staged = await invoke('worker', stage);
  assert.equal(staged.status, 200);
  assert.equal(staged.body.status, 'applied');
  const stagedAgain = await invoke('worker', stage);
  assert.equal(stagedAgain.body.status, 'replayed');
  assert.equal(stagedAgain.body.document.revision, staged.body.document.revision);
  const changed = await invoke('worker', { ...stage, mutationId: randomUUID(), payload: 'changed' });
  assert.equal(changed.status, 409);
  const reusedIdentity = await invoke('worker', { ...stage, payload: 'changed' });
  assert.equal(reusedIdentity.status, 409);
  const preservedPart = await invoke('worker', { action: 'read', kind: 'part', id: part });
  assert.equal(preservedPart.body.revision, staged.body.document.revision);
  assert.equal(preservedPart.body.body.payload, stage.payload);
  check('immutable staging and identical replay');
  phase = 'incomplete_publication';
  const commit = { action: 'commit', id: head, mutationId: randomUUID(), expectedRevision: null,
    partIds: [part], value: 1 };
  const incomplete = await invoke('worker', { ...commit, partIds: [`${run}_missing`] });
  assert.equal(incomplete.status, 409);
  assert.equal(incomplete.body.error, 'incomplete_manifest');
  assert.equal((await invoke('worker', read)).body, null);
  check('missing partition prevents publication');
  phase = 'commit_and_lost_response_replay';
  // Ignore the original result until after retry to model a caller losing its response.
  const initialPromise = invoke('worker', commit);
  await initialPromise;
  const replay = await invoke('worker', commit);
  const initial = await initialPromise;
  assert.equal(initial.body.status, 'applied');
  assert.equal(replay.body.status, 'replayed');
  assert.equal(initial.body.document.revision, replay.body.document.revision);
  check('committed response can be recovered by retry');
  phase = 'concurrent_compare_and_swap';
  const candidates = [2, 3].map((value) => ({ ...commit, mutationId: randomUUID(), value,
    expectedRevision: initial.body.document.revision }));
  const outcomes = await Promise.all(candidates.map((candidate) => invoke('worker', candidate)));
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
  const winner = outcomes.find((r) => r.body.status === 'applied');
  assert.ok(winner);
  const current = await invoke('worker', read);
  assert.equal(current.body.revision, winner.body.document.revision);
  assert.equal(current.body.body.value, winner.body.document.body.value);
  check('exactly one concurrent writer wins; committed head matches winner');
  phase = 'direct_document_denial';
  const directUrl = `${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/collections/qualification_heads/documents/${head}`;
  for (const role of ['owner', 'foreign', 'worker']) {
    const response = await fetch(directUrl, { signal: AbortSignal.timeout(20_000), headers: {
      'X-Mako-Key': publicKey, Authorization: `Bearer ${sessions.get(role).accessToken}` } });
    // Point reads deliberately hide inaccessible documents as not-found.
    assert.equal(response.status, 404);
  }
  check('all application users denied direct document reads');
  phase = 'request_bounds';
  assert.equal((await invoke('worker', { ...stage, mutationId: randomUUID(), payload: 'x'.repeat(4097) })).status, 400);
  assert.equal((await invoke('worker', { ...stage, mutationId: randomUUID(), payload: 'x'.repeat(13_000) })).status, 413);
  check('gateway rejects oversized payloads');
  if (values.benchmark) {
    phase = 'large_partition_benchmark';
    const count = 96;
    const payload = 'x'.repeat(32768);
    const ids = Array.from({ length: count }, (_, index) => `${run}_large_${index}`);
    const timings = {};
    for (const action of ['stageLarge', 'read']) {
      // Hosted allocation currently returns transient sequencer errors under parallel staging.
      const concurrency = action === 'stageLarge' ? 1 : 4;
      const started = performance.now();
      const requests = [];
      for (let offset = 0; offset < count; offset += concurrency) {
        const batch = await Promise.all(ids.slice(offset, offset + concurrency).map((id) => invoke('worker',
          action === 'read' ? { action, id, kind: 'largePart' } : { action, id, mutationId: randomUUID(), payload })));
        for (const result of batch) {
          if (result.status !== 200) report.benchmarkFailure = { action, offset,
            status: result.status, upstreamStatus: result.body?.upstreamStatus,
            upstreamReason: result.body?.upstreamReason };
          assert.equal(result.status, 200);
          assert.equal(action === 'read' ? result.body.body.payload : result.body.document.body.payload, payload);
          requests.push(result.milliseconds);
        }
      }
      requests.sort((a, b) => a - b);
      timings[action] = { totalMilliseconds: Math.round(performance.now() - started),
        concurrency, medianMilliseconds: requests[Math.floor(count / 2)], p95Milliseconds: requests[Math.floor(count * 0.95)] };
      check(`${action}: ${count} synthetic 32 KiB partitions at concurrency ${concurrency}`);
    }
    const publication = await invoke('worker', { action: 'commitLarge', id: `${run}_large_head`,
      mutationId: randomUUID(), expectedRevision: null, partIds: ids.slice(0, 16), value: 1 });
    assert.equal(publication.status, 200);
    assert.equal(publication.body.status, 'applied');
    assert.equal((await invoke('worker', { action: 'stageLarge', id: `${run}_oversized`,
      mutationId: randomUUID(), payload: payload + 'x' })).status, 400);
    assert.equal((await invoke('worker', { action: 'stageLarge', id: `${run}_oversized`,
      mutationId: randomUUID(), payload: 'x'.repeat(211000) })).status, 413);
    report.benchmark = { count, payloadBytes: 32768, totalPayloadBytes: count * 32768,
      timings, sixteenPartCommitMilliseconds: publication.milliseconds };
    check('32 KiB bounds and sixteen-part publication');
  }
  phase = 'session_renewal';
  const renewed = await auths.get('worker').refreshSession();
  sessions.set('worker', renewed);
  assert.equal((await invoke('worker', read)).status, 200);
  check('renewed worker session works');
  phase = 'session_revocation';
  const revokedToken = renewed.accessToken;
  await auths.get('worker').signOut();
  assert.equal((await invoke('worker', read, revokedToken)).status, 401);
  check('revoked worker session denied');
  report.latenciesMilliseconds = { stage: staged.milliseconds, commit: initial.milliseconds,
    read: current.milliseconds, concurrent: outcomes.map((r) => r.milliseconds) };
  report.complete = true;
} catch (error) {
  // Never print assertion values, upstream messages, tokens, or credential paths.
  report.failure = { phase, type: error.name, ...(Number.isInteger(error.status) ? { status: error.status } : {}) };
  if (Number.isInteger(error.actual) && Number.isInteger(error.expected)) {
    report.failure.actualStatus = error.actual;
    report.failure.expectedStatus = error.expected;
  }
  console.error(`Qualification stopped during ${phase} (${error.name}); no cutover performed.`);
  process.exitCode = 1;
} finally {
  for (const auth of auths.values()) {
    try { await auth.signOut(); } catch { /* A hosted outage must not hide the original failure. */ }
  }
  report.finishedAt = new Date().toISOString();
  // The file is exclusively reserved above. Do not overwrite an earlier run on reservation failure.
  if (reportReserved) {
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}
