// Live-cloud transport test of the actual auth/RxDB materializer. IndexedDB and
// browser storage stay isolated in memory; financial writes belong to API smoke.
import 'fake-indexeddb/auto';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3 || ((await stat(directory)).mode & 0o077)) throw new Error('A private migration directory is required');
const root = resolve(import.meta.dirname, '..');
const afterWrites = JSON.parse(await readFile(resolve(directory, 'postwrite-cloud-export.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve(directory, 'cloud-export.json'), 'utf8'));
const identities = JSON.parse(await readFile(resolve(root, '../.local/mako-migration/qualification-identities.json'), 'utf8'));
class Storage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
const storage = new Storage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
const windowTarget = new EventTarget(); windowTarget.localStorage = storage; windowTarget.indexedDB = globalThis.indexedDB;
Object.defineProperty(globalThis, 'window', { value: windowTarget, configurable: true });
Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const realFetch = globalThis.fetch;
let offline = false, app, step = 'initialization';
const transport = { requests: 0, rateLimited: 0 };
globalThis.fetch = async (url, init) => {
  if (offline) throw new TypeError('Offline test');
  const response = await realFetch(url, init);
  transport.requests++;
  if (response.status === 429) transport.rateLimited++;
  return response;
};
const report = { complete: false, checks: [], initialVersion: afterWrites.version };
const outputDirectory = resolve(root, 'node_modules/.cache/robinlab-tests');
await mkdir(outputDirectory, { recursive: true });
const output = resolve(outputDirectory, `live-${process.pid}.mjs`);
async function save(name, value) { await writeFile(resolve(directory, name), JSON.stringify(value) + '\n', { mode: 0o600 }); }
async function passed(name) { report.checks.push(name); await save('live-replication-report.json', report); console.log('Passed live replication: ' + name); }
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, milliseconds = 600000) {
  const deadline = Date.now() + milliseconds;
  let nextProgress = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (app.getSyncStatus().phase === 'error') throw new Error('terminal_sync_error');
    if (Date.now() >= nextProgress) {
      const { phase, version, readable } = app.getSyncStatus();
      console.log(JSON.stringify({ step, phase, version, readable, ...transport }));
      nextProgress = Date.now() + 30000;
    }
    await wait(500);
  }
  throw new Error('synchronization_timeout');
}
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const rows = (values) => values.map(canonical).sort();
async function verify(expected, version) {
  const generation = await app.readGeneration();
  assert.equal(generation.version, version);
  for (const table of ['accounts', 'tickers', 'transactions', 'ticker_splits', 'account_value_snapshots']) assert.deepEqual(rows(generation.tables[table]), rows(expected.tables[table].rows));
  const dataset = await app.getDataset();
  assert.deepEqual(rows(dataset.historical), rows(expected.tables.price_cache.rows));
  assert.deepEqual(rows(dataset.prices), rows(expected.tables.latest_price_cache.rows.map((r) => ({ symbol: r.symbol, price: r.latest_price, price_date: r.latest_price_date }))));
}
try {
  await build({ stdin: { contents: "export * from './src/api/auth.ts'; export * from './src/api/rxdb.ts';", resolveDir: root }, bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: output, define: { 'import.meta.hot': 'undefined' }, logLevel: 'silent' });
  app = await import(pathToFileURL(output));
  await app.initializeAuth(); assert.equal(app.getAuthState().status, 'signed-out');
  await passed('fresh sign-in boundary');
  step = 'real cloud initial replication';
  await app.signIn(identities.owner.email, identities.owner.password);
  await app.startReplication();
  await until(() => app.getSyncStatus().readable && app.getSyncStatus().version === afterWrites.version);
  await verify(afterWrites, afterWrites.version);
  await passed('complete real portfolio and price replication matches post-write export');
  step = 'offline reopen';
  await app.closeLocalData(); offline = true; navigator.onLine = false;
  await app.startReplication(); await verify(afterWrites, afterWrites.version);
  assert.equal(app.getSyncStatus().readable, true); assert.equal(app.getSyncStatus().phase, 'offline');
  await passed('offline reopen retains exact portfolio and prices');
  step = 'reconnect';
  await app.closeLocalData(); offline = false; navigator.onLine = true;
  await app.startReplication(); await app.resync();
  await verify(afterWrites, afterWrites.version);
  await passed('reconnect preserves verified generation');
  await save('live-replication-ready.json', { version: afterWrites.version, checks: report.checks });
  console.log('Waiting for journaled API cleanup publication.');
  step = 'live cleanup catch-up';
  let target;
  await until(async () => {
    try { target = JSON.parse(await readFile(resolve(directory, 'live-replication-cleanup-target.json'), 'utf8')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 900000);
  assert.ok(Number.isSafeInteger(target.version) && target.version > afterWrites.version);
  await app.waitForVersion(target.version); await verify(baseline, target.version);
  await passed('live deletion catch-up restores exact baseline tables and prices');
  step = 'sign-out';
  await app.signOut(); assert.equal(app.getAuthState().status, 'signed-out'); assert.equal(app.getSyncStatus().readable, false);
  await passed('sign-out clears protected state');
  report.complete = true; report.finalVersion = target.version;
  await save('live-replication-report.json', report);
} catch (error) {
  report.failure = { step, error: error.name };
  await save('live-replication-report.json', report);
  console.error('Live replication stopped during ' + step + ': ' + error.name); process.exitCode = 1;
} finally {
  offline = false; navigator.onLine = true;
  if (app) { try { await app.signOut(); } catch { /* Preserve original result. */ } await app.closeLocalData(); }
  await unlink(output).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
