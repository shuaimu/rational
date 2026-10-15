import { onClearProtectedState, requireOwnerScope } from './auth';
import { waitForVersion, waitForCacheGeneration } from './rxdb';
export type JobState = 'queued' | 'running' | 'committing' | 'retry' | 'completed' | 'failed' | 'cancelled' | 'needs-attention';
export interface CloudJob {
  id: string; kind: string; state: JobState; attempt: number; retryAt: number | null;
  cancelRequested: boolean; error: string | null;
  result: { version: number; cacheGeneration?: number; response: unknown } | null;
  resumePath?: string;
}
export class JobFailure extends Error { state: JobState; constructor(state: JobState) { super(state === 'cancelled' ? 'The cloud operation was cancelled.' : state === 'needs-attention' ? 'This operation needs review before it can continue.' : 'The cloud operation failed. Review its status before retrying.'); this.state = state; this.name = 'JobFailure'; } }
export interface JobCommand { scope: string; fingerprint: string; id: string }
export interface TrackedJob {
  scope: string; id: string; kind: string; state: JobState; attempt: number;
  retryAt: number | null; cancelRequested: boolean; error: string | null;
  command?: JobCommand; resumePath?: string; waitingForSync?: boolean; settled?: boolean;
}
const prefix = 'robinlab.jobs.';
const key = (scope: string) => prefix + encodeURIComponent(scope);
let currentScope = '';
let snapshot: TrackedJob[] = [];
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<CloudJob>>();
let transport: { list: (cursor: string | null) => Promise<{ jobs: CloudJob[]; cursor: string | null }>; get: (id: string) => Promise<CloudJob>; cancel: (id: string) => Promise<CloudJob>; complete: (command: JobCommand) => void };
let discovery: Promise<void> | null = null;
let nextDiscovery = 0;
const recoveryOrder = new Map<string, number>();
const nextRecovery = new Map<string, number>();
let recoverySequence = 0;
const recoveryConcurrency = 1;
export function configureJobs(value: typeof transport) { transport = value; }
export const subscribeJobs = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getJobs = () => snapshot;
const terminal = (state: JobState) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(state);
function emit() { for (const listener of listeners) listener(); }
function openScope(scope: string) {
  if (currentScope === scope) return;
  currentScope = scope;
  try { snapshot = JSON.parse(localStorage.getItem(key(scope)) ?? '[]') as TrackedJob[]; }
  catch { snapshot = []; }
  snapshot = snapshot.filter(job => job.scope === scope && /^j_[a-f0-9]{64}$/.test(job.id));
  emit();
}
function persist() {
  if (requireOwnerScope() !== currentScope) throw new Error('Application session changed.');
  localStorage.setItem(key(currentScope), JSON.stringify(snapshot)); emit();
}
function replace(job: TrackedJob) { snapshot = [...snapshot.filter(row => row.id !== job.id), job]; persist(); }
export function trackJob(job: CloudJob, command?: JobCommand) {
  const scope = requireOwnerScope(); openScope(scope);
  if (!/^j_[a-f0-9]{64}$/.test(job.id)) throw new Error('Invalid cloud job response.');
  const old = snapshot.find(row => row.id === job.id);
  replace({ ...old, scope, id: job.id, kind: job.kind, state: job.state, attempt: job.attempt, retryAt: job.retryAt, cancelRequested: job.cancelRequested, error: job.error, ...(job.state === 'completed' ? { settled: false, waitingForSync: (job.result?.version ?? 0) > 0 } : {}), ...(command ? { command } : {}), ...(job.resumePath ? { resumePath: job.resumePath } : {}) });
}
export async function refreshJob(id: string): Promise<CloudJob> {
  const pending = inflight.get(id); if (pending) return pending;
  const scope = requireOwnerScope(); openScope(scope);
  const task = (async () => {
    const result = await transport.get(id);
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    trackJob(result);
    const tracked = snapshot.find(row => row.id === id)!;
    if (result.state === 'completed') {
      const version = result.result?.version ?? 0;
      const cacheGeneration = result.result?.cacheGeneration ?? 0;
      if (version > 0 || cacheGeneration > 0) {
        replace({ ...tracked, waitingForSync: true });
        try { if (version > 0) await waitForVersion(version); if (cacheGeneration > 0) await waitForCacheGeneration(cacheGeneration); }
        catch { return result; }
      }
      if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
      if (tracked.command) transport.complete(tracked.command);
      replace({ ...tracked, waitingForSync: false, settled: true });
    }
    return result;
  })().finally(() => { inflight.delete(id); });
  inflight.set(id, task); return task;
}
export async function waitForJob(job: CloudJob, command?: JobCommand): Promise<{ response: unknown; version: number; resumePath?: string }> {
  trackJob(job, command); const scope = requireOwnerScope();
  for (;;) {
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    const current = await refreshJob(job.id);
    if (current.state === 'completed' && current.result) return { ...current.result, resumePath: snapshot.find(row => row.id === job.id)?.resumePath };
    if (terminal(current.state)) throw new JobFailure(current.state);
    // Queued/checkpointed work advances on the hourly cloud dispatcher.
    await new Promise(resolve => setTimeout(resolve, ['queued', 'retry'].includes(current.state) ? 60_000 : 5000));
  }
}
export async function cancelJob(id: string) { trackJob(await transport.cancel(id)); }
export function dismissJob(id: string) {
  const job = snapshot.find(row => row.id === id);
  if (!job || !terminal(job.state) || job.waitingForSync) return;
  if (job.command) transport.complete(job.command);
  snapshot = snapshot.filter(row => row.id !== id); recoveryOrder.delete(id); nextRecovery.delete(id); persist();
}
export function recoverJobs() {
  let scope: string; try { scope = requireOwnerScope(); } catch { return; }
  openScope(scope);
  if (!discovery && Date.now() >= nextDiscovery) {
    nextDiscovery = Date.now() + 300_000;
    discovery = (async () => {
      let cursor: string | null = null;
      do {
        const page = await transport.list(cursor);
        if (requireOwnerScope() !== scope) return;
        for (const job of page.jobs) trackJob(job);
        cursor = page.cursor;
      } while (cursor);
    })().catch(() => { /* Retry discovery after reconnect; known jobs remain. */ }).finally(() => { discovery = null; });
  }
  // Five-minute discovery refreshes queued background work in pages. Poll only active work
  // and this device's commands individually; a migrated backlog must not create
  // hundreds of simultaneous function/auth requests on every timer tick.
  const candidates = snapshot.filter(job => !inflight.has(job.id) && Date.now() >= (nextRecovery.get(job.id) ?? 0) && (
    job.waitingForSync || job.state === 'completed' && !job.settled ||
    !terminal(job.state) && (job.state !== 'queued' || job.command)
  )).sort((a, b) => (recoveryOrder.get(a.id) ?? 0) - (recoveryOrder.get(b.id) ?? 0));
  for (const job of candidates.slice(0, Math.max(0, recoveryConcurrency - inflight.size))) {
    recoveryOrder.set(job.id, ++recoverySequence);
    nextRecovery.set(job.id, Date.now() + 60_000);
    void refreshJob(job.id).catch(() => { /* Preserve recovery identity for the next bounded retry. */ });
  }
}
onClearProtectedState(async nextScope => {
  for (const name of Object.keys(localStorage)) if (name.startsWith(prefix) && name !== (nextScope ? key(nextScope) : '')) localStorage.removeItem(name);
  currentScope = ''; snapshot = []; nextDiscovery = 0; recoveryOrder.clear(); nextRecovery.clear(); recoverySequence = 0; emit();
});
