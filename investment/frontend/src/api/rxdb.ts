// Mako RxDB transport plus an atomically selected, verified local generation.
import { createRxDatabase, removeRxDatabase, type RxDatabase, type RxCollection, type RxJsonSchema, type MangoQuerySelector } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { replicateRxCollection, type RxReplicationState } from 'rxdb/plugins/replication';
import { DexieReplicationStatePersistence, DexieReplicationStateStore, MakoLiveStreamGroup, createMakoPullOptions, makoReplicationErrorFrom, type MakoCheckpoint } from '@mako-cloud/rxdb';
import Dexie, { type Table } from 'dexie';
import { auth, collectionConfig, getAuthState, initializeAuth, onClearProtectedState, requireOwnerScope, signOut, subscribeAuth } from './auth';
import { digest, IncompleteManifest, InvalidManifest, materialize, validateHead, validateTables, type ContentDoc, type LocalGeneration, type PortfolioHead } from './manifest';
import allSchemas from './mako-schemas.json';
import { isCloudApi } from './runtime';
import { historicalDigest } from '../../../mako/serverless/shared/cache-generation.js';
const schemas = Object.fromEntries(Object.entries(allSchemas).filter(([name]) => isCloudApi || name !== 'cache_status'));
interface CacheStatus { id: string; generation: number; state: 'ready' | 'updating'; jobId: string | null; latest: LatestPrice[]; historicalDigest: string; historicalCount: number; updatedAt: number }

export interface LatestPrice { symbol: string; latest_price: number; latest_price_date: string; source: string; fetched_at: string | null }
export interface HistoricalPrice { symbol: string; price_date: string; price: number; source: string; fetched_at: string | null; is_market_close: boolean }
interface PriceEnvelope<T> { id: string; row: T }
type Collections = { cache_status: RxCollection<CacheStatus>; portfolio_heads: RxCollection<PortfolioHead>; portfolio_public: RxCollection<ContentDoc>; latest_prices: RxCollection<PriceEnvelope<LatestPrice>>; historical_prices: RxCollection<PriceEnvelope<HistoricalPrice>> };
type Transport = RxDatabase<Collections>;
export type SyncStatus = { phase: 'starting' | 'syncing' | 'ready' | 'offline' | 'recovering' | 'error'; version: number; pendingVersion: number; readable: boolean; message: string | null };
let status: SyncStatus = { phase: 'starting', version: 0, pendingVersion: 0, readable: false, message: null };
const listeners = new Set<() => void>();
export const getSyncStatus = () => status;
export const subscribeSync = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(patch: Partial<SyncStatus>) { status = { ...status, ...patch }; for (const listener of listeners) listener(); }
interface MetaRow { key: string; value: unknown }
class LocalModels extends Dexie { state!: Table<MetaRow, string>; constructor(name: string) { super(name); this.version(1).stores({ state: '&key' }); } }
interface Descriptor { scope: string; meta: string; transport: string; checkpoints: string }
const registryKey = 'robinlab.mako.databases.v1';
function descriptors(): Descriptor[] { try { return JSON.parse(localStorage.getItem(registryKey) ?? '[]'); } catch { throw new Error('Local database registry is unavailable.'); } }
function register(descriptor: Descriptor) { const all = descriptors().filter((d) => d.transport !== descriptor.transport); all.push(descriptor); localStorage.setItem(registryKey, JSON.stringify(all)); }
interface PriceView { generation?: number; latest: LatestPrice[]; historical: HistoricalPrice[] }
interface Runtime { transientErrors: Set<string>; prices: PriceView | null; priceReady: Set<string>; priceTimer?: ReturnType<typeof setTimeout>; pricing: boolean; priceAgain: boolean; scope: string; descriptor: Descriptor; meta: LocalModels; db: Transport; durable: DexieReplicationStateStore; replicas: RxReplicationState<unknown, MakoCheckpoint>[]; live: MakoLiveStreamGroup | null; active: LocalGeneration | null; stopped: boolean; stopping: Promise<void> | null; building: boolean; again: boolean; closeSubscriptions: (() => void)[]; recovery: Promise<void> | null }
let runtime: Runtime | undefined;
let opening: Promise<Runtime> | undefined;
const storage = getRxStorageDexie();

async function stop(current: Runtime) {
  if (current.stopping) return current.stopping;
  current.stopped = true;
  current.stopping = (async () => {
    clearTimeout(current.priceTimer); current.live?.close(); current.live = null;
    for (const close of current.closeSubscriptions.splice(0)) close();
    await Promise.all(current.replicas.splice(0).map((r) => r.cancel()));
    // The BroadcastChannel elector can still have an election in flight after
    // replication cancellation. The browser's Web Locks elector has no
    // applyOnce(); its die() hook cancels the lock request during db.close().
    const elector = current.db.leaderElector();
    if (typeof elector.applyOnce === 'function') await elector.applyOnce();
    await current.db.close(); current.durable.close(); current.meta.close();
  })();
  return current.stopping;
}
async function removeDescriptor(d: Descriptor, removeMeta: boolean) {
  await removeRxDatabase(d.transport, storage);
  await Dexie.delete(d.checkpoints);
  if (removeMeta) await Dexie.delete(d.meta);
}
onClearProtectedState(async (nextScope) => {
  if (runtime) { await stop(runtime); runtime = undefined; }
  if (opening) { try { const pending = await opening; if (!pending.stopped) await stop(pending); } catch { /* No open transport. */ } opening = undefined; }
  const all = descriptors();
  for (const d of all) if (d.scope !== nextScope) await removeDescriptor(d, true);
  localStorage.setItem(registryKey, JSON.stringify(all.filter((d) => d.scope === nextScope)));
  update({ phase: 'starting', version: 0, pendingVersion: 0, readable: false, message: null });
});

function currentScope(current: Runtime): boolean { return !current.stopped && getAuthState().status === 'ready' && getAuthState().scope === current.scope; }
async function buildGeneration(current: Runtime): Promise<void> {
  if (!currentScope(current)) return;
  if (current.building) { current.again = true; return; }
  current.building = true;
  try {
    do {
      current.again = false;
      const document = await current.db.portfolio_heads.findOne('portfolio').exec();
      if (!document) { update({ phase: current.active ? 'syncing' : 'starting', message: 'Waiting for the cloud portfolio.' }); return; }
      const head = document.toJSON() as PortfolioHead; validateHead(head);
      if (current.active && head.sequence <= current.active.version) {
        if (head.sequence === current.active.version && head.public_root.id !== current.active.root.id) throw new InvalidManifest();
        return;
      }
      update({ phase: 'syncing', message: 'Synchronizing portfolio records…' });
      const next = await materialize(head, async (id) => { const d = await current.db.portfolio_public.findOne(id).exec(); return d ? d.toJSON() as ContentDoc : null; });
      if (!currentScope(current)) return;
      // A single IndexedDB transaction replaces the complete multi-table view.
      const published = await current.meta.transaction('rw', current.meta.state, async () => {
        const previous = (await current.meta.state.get('active'))?.value as LocalGeneration | undefined;
        if (previous && previous.version >= next.version) {
          if (previous.version === next.version && previous.root.id !== next.root.id) throw new InvalidManifest();
          return previous;
        }
        await current.meta.state.put({ key: 'active', value: next });
        return next;
      });
      if (!currentScope(current)) return;
      current.active = published;
      update({ readable: current.prices !== null, version: published.version, pendingVersion: status.pendingVersion > published.version ? status.pendingVersion : 0, phase: 'ready', message: null });
    } while (current.again);
  } catch (error) {
    if (!currentScope(current)) return;
    if (error instanceof IncompleteManifest) update({ phase: 'syncing', message: error.message });
    else { update({ phase: 'error', message: 'Portfolio verification failed. Reload local data to retry.' }); current.live?.close(); await Promise.all(current.replicas.map((r) => r.cancel())); }
  } finally { current.building = false; if (current.again && currentScope(current)) queueMicrotask(() => void buildGeneration(current)); }
}

async function recover(current: Runtime, reason: string, security = false): Promise<void> {
  if (current.recovery) return current.recovery;
  current.recovery = (async () => {
    update({ phase: 'recovering', message: 'Rebuilding the authorized local cache…' });
    if (security) { await signOut(); return; }
    await current.meta.state.put({ key: 'reset', value: reason });
    await stop(current); runtime = undefined; opening = undefined;
    await removeDescriptor(current.descriptor, false);
    await startReplication();
  })().catch(() => { update({ phase: 'error', message: 'Cache recovery failed. Close other RobinLab tabs and reload.' }); });
  return current.recovery;
}
function replicationError(current: Runtime, raw: unknown, collectionId: string) {
  if (!currentScope(current)) return;
  const error = makoReplicationErrorFrom(raw);
  if (!error) { update({ phase: 'error', message: 'Local replication failed. Reload local data to retry.' }); void Promise.all(current.replicas.map((r) => r.cancel())); current.live?.close(); return; }
  if (['unauthenticated', 'permission_denied'].includes(error.code)) { void recover(current, error.code, true); return; }
  if (['checkpoint_expired', 'full_resync_required'].includes(error.code)) { void recover(current, error.code); return; }
  if (error.code.includes('authorization')) { void recover(current, error.code, true); return; }
  if (error.code.includes('schema') || !error.retryable) { update({ phase: 'error', message: 'The cloud schema or access policy changed. Update the app before retrying.' }); current.live?.close(); void Promise.all(current.replicas.map((r) => r.cancel())); return; }
  current.transientErrors.add(collectionId);
  update({ phase: error.status === 429 ? 'syncing' : 'offline', message: error.status === 429 ? 'Cloud rate limit reached; synchronization will retry.' : 'Offline — showing the last complete portfolio.' });
}

async function openRuntime(): Promise<Runtime> {
  await initializeAuth(); const scope = requireOwnerScope();
  const hash = (await digest(scope)).slice(0, 32); const metaName = `robinlab-model-${hash}`;
  const meta = new LocalModels(metaName); await meta.open();
  const reset = await meta.state.get('reset');
  let nonce = (await meta.state.get('transportGeneration'))?.value;
  if (reset || typeof nonce !== 'string') { nonce = crypto.randomUUID().replaceAll('-', ''); await meta.state.put({ key: 'transportGeneration', value: nonce }); }
  const descriptor = { scope, meta: metaName, transport: `robinlab-transport-${hash}-${nonce}`, checkpoints: `robinlab-checkpoints-${hash}-${nonce}` };
  // A prior reset may have been interrupted before removing transport/checkpoints.
  for (const d of descriptors()) if (d.scope === scope && d.transport !== descriptor.transport) await removeDescriptor(d, false);
  register(descriptor);
  const db = await createRxDatabase<Collections>({ name: descriptor.transport, storage, multiInstance: true });
  await db.addCollections(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, { schema: { ...schema, version: 0, primaryKey: 'id' } as unknown as RxJsonSchema<unknown> }] )) as Parameters<Transport['addCollections']>[0]);
  const durable = new DexieReplicationStateStore({ databaseName: descriptor.checkpoints });
  let active = (await meta.state.get('active'))?.value as LocalGeneration | undefined;
  if (active) { try { validateTables(active.tables); if (!Number.isSafeInteger(active.version) || active.version < 1) throw new Error(); } catch { active = undefined; await meta.state.delete('active'); } }
  const savedPrices = (await meta.state.get('prices'))?.value as PriceView | undefined;
  const prices = savedPrices && Array.isArray(savedPrices.latest) && Array.isArray(savedPrices.historical) ? savedPrices : null;
  const current: Runtime = { transientErrors: new Set(), prices, priceReady: new Set(), pricing: false, priceAgain: false, scope, descriptor, meta, db, durable, active: active ?? null, replicas: [], live: null, stopped: false, stopping: null, building: false, again: false, closeSubscriptions: [], recovery: null };
  if (getAuthState().scope !== scope || getAuthState().status !== 'ready') { await stop(current); throw new Error('Application session changed.'); }
  runtime = current;
  const configs = (Object.keys(schemas) as (keyof Collections)[]).map((name) => ({ ...collectionConfig(name), pullBatchSize: name === 'portfolio_public' ? 20 : name === 'historical_prices' ? 500 : 100 }));
  const live = new MakoLiveStreamGroup(configs, auth, { onResyncReason: (reason) => {
    if (reason === 'authorization_epoch_changed') void recover(current, reason, true);
    else if (['checkpoint_expired', 'stream_gap', 'service_failover'].includes(reason)) void recover(current, reason);
  } });
  current.live = live;
  for (const config of configs) {
    const collection = db.collections[config.collectionId as keyof Collections] as RxCollection<unknown>;
    const persistence = new DexieReplicationStatePersistence(config, { store: durable });
    const pull = createMakoPullOptions<unknown>(config, auth, { stream$: live.stream$(config.collectionId), checkpoints: persistence.checkpoint });
    const original = pull.handler;
    pull.handler = async (...args) => {
      try {
        const result = await original(...args);
        // Successful empty pulls do not emit collection changes. Clear a stale
        // transport warning even when the head has not changed (or is absent).
        if (currentScope(current) && current.transientErrors.delete(config.collectionId)
          && current.transientErrors.size === 0 && ['syncing', 'offline'].includes(status.phase)) {
          update({ phase: status.readable ? 'ready' : 'syncing', message: null });
          void buildGeneration(current);
        }
        return result;
      }
      catch (raw) { const error = makoReplicationErrorFrom(raw); if (error?.retryAfterMilliseconds) await new Promise((resolve) => setTimeout(resolve, Math.min(error.retryAfterMilliseconds!, 60_000))); throw raw; }
    };
    const replica = replicateRxCollection<unknown, MakoCheckpoint>({ collection, replicationIdentifier: `${descriptor.transport}-${config.collectionId}`, pull, live: true, retryTime: 2000, waitForLeadership: true });
    current.replicas.push(replica);
    if (config.collectionId.endsWith('_prices') || config.collectionId === 'cache_status') void replica.awaitInitialReplication().then(() => { current.priceReady.add(config.collectionId); void buildPrices(current); }).catch((error) => replicationError(current,error,config.collectionId));
    const errors = replica.error$.subscribe((error) => replicationError(current, error, config.collectionId));
    const changes = collection.$.subscribe(() => { if (config.collectionId.startsWith('portfolio_')) void buildGeneration(current); else { clearTimeout(current.priceTimer); current.priceTimer = setTimeout(() => void buildPrices(current), 750); } });
    current.closeSubscriptions.push(() => errors.unsubscribe(), () => changes.unsubscribe());
  }
  // Hosted jobs can finish while the browser's live connection is quiet or
  // interrupted. Periodically pull from durable checkpoints so missed stream
  // notifications cannot leave a readable portfolio indefinitely stale.
  const catchUp = setInterval(() => {
    if (currentScope(current) && navigator.onLine) for (const replica of current.replicas) replica.reSync();
  }, 30_000);
  current.closeSubscriptions.push(() => clearInterval(catchUp));
  await meta.state.delete('reset');
  update({ readable: !!active && !!prices, version: active?.version ?? 0, phase: !navigator.onLine ? 'offline' : active ? 'ready' : 'syncing', message: !navigator.onLine ? 'Offline — showing the last complete portfolio.' : null });
  void buildGeneration(current);
  return current;
}
export async function startReplication(): Promise<void> {
  await initializeAuth(); requireOwnerScope();
  if (!opening) opening = openRuntime().catch((error) => { opening = undefined; throw error; });
  await opening;
}
export async function readGeneration(): Promise<LocalGeneration> {
  await startReplication(); requireOwnerScope();
  if (runtime?.active) return runtime.active;
  await waitForVersion(1);
  requireOwnerScope();
  if (!runtime?.active) throw new Error('The cloud portfolio is still synchronizing.');
  return runtime.active;
}
export async function waitForCacheGeneration(generation: number): Promise<void> {
  await startReplication(); const scope = requireOwnerScope();
  for (const replica of runtime?.replicas ?? []) replica.reSync();
  const deadline = Date.now() + 60_000;
  while ((runtime?.prices?.generation ?? 0) < generation) {
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    if (Date.now() >= deadline) throw new Error('Prices are saved; this device is still synchronizing.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
export async function waitForVersion(version: number): Promise<void> {
  await startReplication(); requireOwnerScope();
  if ((runtime?.active?.version ?? 0) >= version) return;
  update({ pendingVersion: Math.max(status.pendingVersion, version), phase: 'syncing', message: 'Saved to cloud; waiting for this device to catch up…' });
  for (const replica of runtime?.replicas ?? []) replica.reSync();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Saved to cloud. This device is still synchronizing; do not submit the write again.')), 60_000);
    const check = () => {
      if (getAuthState().status !== 'ready') finish(new Error('Application session ended.'));
      else if (status.version >= version) finish();
      else if (status.phase === 'error') finish(new Error(status.message ?? 'Synchronization failed.'));
    };
    const off = subscribeSync(check); const offAuth = subscribeAuth(check);
    function finish(error?: Error) { clearTimeout(timeout); off(); offAuth(); if (error) reject(error); else resolve(); }
    check();
  });
}
// Close handles without deleting the verified view, e.g. when remounting the app.
export async function closeLocalData(): Promise<void> {
  if (opening) { try { await opening; } catch { /* No database was opened. */ } }
  if (runtime) await stop(runtime);
  runtime = undefined; opening = undefined;
}
export async function resync(): Promise<void> { await startReplication(); for (const replica of runtime?.replicas ?? []) replica.reSync(); }
export async function resetLocalData(): Promise<void> { if (runtime) await recover(runtime, 'user_requested'); else { opening = undefined; await startReplication(); } }
async function readPriceRows<T>(current: Runtime, collection: RxCollection<PriceEnvelope<T>>): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  // Bound each IndexedDB read so a large history does not monopolize a single
  // transaction or delay sign-out. Collection changes schedule another pass.
  while (currentScope(current)) {
    const selector = (after === undefined ? {} : { id: { $gt: after } }) as MangoQuerySelector<PriceEnvelope<T>>;
    const page = await collection.find({ selector, sort: [{ id: 'asc' }], limit: 500 }).exec();
    rows.push(...page.map((document) => ({ ...document.row })));
    if (page.length < 500) break;
    after = page[page.length - 1].id;
  }
  return rows;
}
async function buildPrices(current: Runtime): Promise<void> {
  if (!currentScope(current) || current.priceReady.size < (isCloudApi ? 3 : 2)) return;
  if (current.pricing) { current.priceAgain = true; return; }
  current.pricing = true;
  try {
    do {
      current.priceAgain = false;
      const cacheHead = isCloudApi ? (await current.db.cache_status.findOne('cache').exec())?.toJSON() as CacheStatus | undefined : undefined;
      if (isCloudApi && (!cacheHead || cacheHead.state !== 'ready')) return;
      const [mirroredLatest, historical] = await Promise.all([readPriceRows(current, current.db.latest_prices), readPriceRows(current, current.db.historical_prices)]);
      if (cacheHead) {
        if (historical.length !== cacheHead.historicalCount || await historicalDigest(historical) !== cacheHead.historicalDigest) return;
        const newest = await current.db.cache_status.findOne('cache').exec();
        if (newest?.generation !== cacheHead.generation || newest?.state !== 'ready') return;
      }
      const prices: PriceView = { generation: cacheHead?.generation, latest: cacheHead?.latest ?? mirroredLatest, historical };
      if (!prices.latest.every((r) => typeof r.symbol === 'string' && Number.isFinite(r.latest_price)) || !prices.historical.every((r) => typeof r.symbol === 'string' && Number.isFinite(r.price))) throw new InvalidManifest();
      if (!currentScope(current)) return;
      await current.meta.state.put({ key: 'prices', value: prices });
      if (!currentScope(current)) return;
      current.prices = prices;
      update({ readable: current.active !== null, version: current.active?.version ?? 0 });
    } while (current.priceAgain);
  } catch { if (currentScope(current)) update({ phase: 'error', message: 'Price cache verification failed. Reload local data to retry.' }); }
  finally { current.pricing = false; }
}
export async function getDataset() {
  const generation = await readGeneration(); const current = runtime!;
  if (requireOwnerScope() !== current.scope) throw new Error('Application session changed.');
  const prices = current.prices;
  if (!prices) throw new Error('Price history is synchronizing.');
  return { txns: generation.tables.transactions, accounts: generation.tables.accounts, tickers: generation.tables.tickers,
    prices: prices.latest.map((d) => ({ symbol: d.symbol, price: d.latest_price, price_date: d.latest_price_date })),
    historical: prices.historical, snapshots: generation.tables.account_value_snapshots,
    brokers: generation.tables.broker_balances, today: new Date().toISOString().slice(0, 10), version: generation.version };
}
export type Dataset = Awaited<ReturnType<typeof getDataset>>;
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
