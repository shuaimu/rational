// Create-only fallback for sealed cache migration. Never publishes a head.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { MakoAuthClient, MemoryAuthSessionPersistence, normalizeMakoRxdbConfig } from '@mako-cloud/rxdb';
import { StageError, retryable, verifyDocument, createRecords } from './mako-stage-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'allow-cloud-writes': { type: 'boolean' }, limit: { type: 'string' }, 'batch-size': { type: 'string' }, concurrency: { type: 'string' } } });
if (positionals.length !== 1 || !values['allow-cloud-writes']) throw new Error('Usage: mako-stage-cache.mjs DIRECTORY --allow-cloud-writes [--limit 16] [--batch-size 4] [--concurrency 2]');
const directory = resolve(positionals[0]);
const limit = values.limit === undefined ? null : Number(values.limit);
if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)) throw new Error('--limit must be 1 through 16');
const providerBatchSize = Number(values['batch-size'] ?? 4);
if (!Number.isSafeInteger(providerBatchSize) || providerBatchSize < 1 || providerBatchSize > 16) throw new Error('--batch-size must be 1 through 16');
const concurrency = Number(values.concurrency ?? 2);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1 through 4');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
let stopping = false, auth, lock, sealedPackage;
const lockPath = resolve(directory, 'gateway-staging.lock');
const stop = () => { stopping = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const checkStop = () => { if (stopping) throw new StageError('stopped_between_operations'); };
const report = { format: 1, complete: false, headPublished: false, collections: {}, metrics: { statuses: {}, actions: {} } };

async function atomic(name, value) {
  const path = resolve(directory, name), temporary = path + `.tmp-${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
async function expectedDocuments(kind) {
  const rows = new Map();
  const bytes = await readFile(resolve(directory, kind + '.jsonl'));
  if (sha(bytes) !== sealedPackage.files[kind + '.jsonl']) throw new StageError('sealed_source_changed');
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    const body = JSON.parse(line);
    if (rows.has(body.id)) throw new StageError('duplicate_source_key');
    rows.set(body.id, body);
  }
  return rows;
}

async function main() {
  assert.equal((await stat(directory)).mode & 0o077, 0);
  execFileSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); import mako_cloud; mako_cloud.validate(Path(sys.argv[1]))', directory], { cwd: root, stdio: 'pipe' });
  report.packageSha256 = sha(await readFile(resolve(directory, 'package.json')));
  sealedPackage = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const jobs = JSON.parse(await readFile(resolve(directory, 'bulk-jobs.json'), 'utf8'));
  if (Object.values(jobs).some((job) => !['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state))) throw new StageError('bulk_jobs_must_be_terminal');
  lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
  const config = JSON.parse(await readFile(resolve(root, 'mako/runtime.json'), 'utf8'));
  assert.equal(config.endpoint, 'https://cloud-test.makodb.com');
  assert.equal(config.projectId, 'prj_43f3756d4588d7412cbe0b633a455695');
  assert.equal(config.environmentId, 'env_833a71a6da540180b4e64c05cfb90e6d');
  const identityPath = resolve(root, '.local/mako-migration/qualification-identities.json');
  assert.equal((await stat(identityPath)).mode & 0o077, 0);
  const identities = JSON.parse(await readFile(identityPath, 'utf8'));
  auth = new MakoAuthClient(normalizeMakoRxdbConfig({ ...config, collectionId: 'portfolio_heads', schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'node' }), {
    persistence: new MemoryAuthSessionPersistence(), fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }),
  });
  const session = await auth.signInWithPassword(identities.worker.email, identities.worker.password);
  assert.equal(session.user.id, config.workerId);
  const url = `${config.endpoint}/${config.projectId}--${config.environmentId}/functions/v1/robinlab-repository`;
  function measured(action, status, started) {
    report.metrics.statuses[status] = (report.metrics.statuses[status] ?? 0) + 1;
    const timing = report.metrics.actions[action] ??= { count: 0, totalMs: 0, maxMs: 0 };
    const elapsed = Date.now() - started;
    timing.count++; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed);
  }
  async function once(input) {
    let response;
    const started = Date.now();
    const token = await auth.validAccessToken();
    try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mako-Key': config.publicProjectKey, Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) }); }
    catch { measured(input.action, 0, started); throw new StageError('network_unavailable'); }
    const body = await response.json().catch(() => undefined);
    measured(input.action, response.status, started);
    if (response.status !== 200) throw new StageError('gateway_request_failed', response.status, Math.min(60000, Math.max(1000, Number(body?.retryAfterMs) || 1000)));
    if (body === undefined) throw new StageError('invalid_gateway_response');
    return body;
  }
  async function call(input) {
    const read = ['read', 'cache_read', 'cache_query'].includes(input.action);
    for (let attempt = 0; ; attempt++) {
      if (!read) checkStop();
      try { return await once(input); }
      catch (error) {
        if (!read || !retryable(error) || attempt >= 6) throw error;
        await wait(Math.min(30000, Math.max(error.retryAfterMs || 0, 1000 * 2 ** attempt)));
      }
    }
  }
  const noHead = async () => { if (await call({ action: 'read', kind: 'head', id: 'portfolio' }) !== null) throw new StageError('head_already_published'); };
  async function reconcile(kind, expected) {
    const seen = new Set(), cursors = new Set(), lines = [];
    let cursor = null;
    do {
      checkStop();
      const page = await call({ action: 'cache_query', kind, query: { index: 'all', value: null, from: null, through: null, cursor, limit: 500 } });
      if (!page || !Array.isArray(page.documents) || page.documents.length > 500 || !Object.hasOwn(page, 'nextCursor')) throw new StageError('invalid_gateway_page');
      for (const document of page.documents) {
        const id = document.body?.id;
        if (!expected.has(id) || seen.has(id)) throw new StageError('destination_collision');
        verifyDocument(document, expected.get(id)); seen.add(id); lines.push(JSON.stringify(document.body));
      }
      cursor = page.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 16384 || !page.documents.length || cursors.has(cursor))) throw new StageError('invalid_gateway_cursor');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 10000) throw new StageError('gateway_query_bound_exceeded');
    } while (cursor !== null);
    const artifact = `gateway-${kind}-${Date.now()}.jsonl`, content = lines.join('\n') + '\n';
    await atomic(artifact, content);
    report.collections[kind] = { expected: expected.size, present: seen.size, missing: expected.size - seen.size, artifact, sha256: sha(content) };
    await atomic('gateway-cache-verification.json', report);
    console.log(`${kind}: ${seen.size}/${expected.size} exact records verified`);
    return [...expected.values()].filter((body) => !seen.has(body.id));
  }
  await noHead();
  for (const kind of limit === null ? ['provider_requests', 'split_fetch'] : ['provider_requests']) {
    const expected = await expectedDocuments(kind);
    let missing = await reconcile(kind, expected);
    const verifiedBefore = expected.size - missing.length;
    if (limit !== null) missing = missing.slice(-limit);
    const batchSize = kind === 'provider_requests' ? providerBatchSize : 1;
    let confirmed = 0;
    const started = Date.now();
    for (let offset = 0; offset < missing.length; offset += batchSize * concurrency) {
      checkStop();
      if (offset % 256 === 0) await noHead();
      const group = Array.from({ length: concurrency }, (_, index) => missing.slice(offset + index * batchSize, offset + (index + 1) * batchSize)).filter((rows) => rows.length);
      const settled = await Promise.allSettled(group.map((rows) => createRecords(kind, rows, call, wait)));
      confirmed += settled.filter((result) => result.status === 'fulfilled').reduce((sum, result) => sum + result.value, 0);
      await atomic('gateway-staging-progress.json', { collection: kind, verifiedBefore, confirmed, expected: expected.size, elapsedSeconds: Math.round((Date.now() - started) / 1000), metrics: report.metrics });
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (confirmed % 256 === 0 || confirmed === missing.length) console.log(`${kind}: confirmed ${confirmed}/${missing.length} missing records through gateway`);
    }
    const remaining = await reconcile(kind, expected);
    if (limit === null && remaining.length) throw new StageError('staging_remains_incomplete');
  }
  await noHead();
  if (sha(await readFile(resolve(directory, 'package.json'))) !== report.packageSha256) throw new StageError('sealed_source_changed');
  execFileSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); import mako_cloud; mako_cloud.validate(Path(sys.argv[1]))', directory], { cwd: root, stdio: 'pipe' });
  report.complete = limit === null && Object.values(report.collections).every((item) => item.missing === 0);
  await atomic('gateway-cache-verification.json', report);
  console.log(limit === null ? 'Gateway cache staging verified; head remains unpublished.' : 'Bounded gateway probe verified; full staging remains incomplete.');
}
try { await main(); }
catch (error) {
  report.failure = { code: error instanceof StageError ? error.code : error.name, status: error.status ?? null };
  if (lock) await atomic('gateway-cache-verification.json', report);
  console.error('Gateway staging stopped: ' + report.failure.code + (error.status ? ` (HTTP ${error.status})` : ''));
  process.exitCode = 1;
} finally {
  if (auth) { try { await auth.signOut(); } catch { /* Keep the original result. */ } }
  if (lock) { await lock.close(); await unlink(lockPath); }
}
