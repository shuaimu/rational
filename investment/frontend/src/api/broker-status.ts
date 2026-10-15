import { onClearProtectedState, requireOwnerScope } from './auth';
import { readStatus } from './http';

export interface BrokerStatus { last_synced_at: string | null }
interface SavedStatus { status: BrokerStatus; checkedAt: number }
const prefix = 'robinlab.broker-status.';
const key = (scope: string) => prefix + encodeURIComponent(scope);

export function savedBrokerStatus(): SavedStatus | undefined {
  const scope = requireOwnerScope();
  try {
    const saved = JSON.parse(localStorage.getItem(key(scope)) ?? 'null');
    if (saved && Number.isFinite(saved.checkedAt) && saved.status &&
      (saved.status.last_synced_at === null || typeof saved.status.last_synced_at === 'string')) return saved;
  } catch { /* Status remains readable when browser storage is unavailable. */ }
}

export async function fetchBrokerStatus(): Promise<BrokerStatus> {
  const scope = requireOwnerScope();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bound the entire read, including authentication before Axios starts its timeout.
    const response = await Promise.race([
      readStatus<BrokerStatus>('/snaptrade/status', controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Cloud sync status timed out. Please retry.'));
          controller.abort();
        }, 15_000);
      }),
    ]);
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    const status = response.data;
    if (!status || !(status.last_synced_at === null || typeof status.last_synced_at === 'string')) {
      throw new Error('Cloud sync status is invalid. Please retry.');
    }
    try { localStorage.setItem(key(scope), JSON.stringify({ status, checkedAt: Date.now() })); }
    catch { /* A storage quota must not hide a successful cloud response. */ }
    return status;
  } finally {
    clearTimeout(timer);
  }
}

onClearProtectedState(async nextScope => {
  for (const name of Object.keys(localStorage)) {
    if (name.startsWith(prefix) && name !== (nextScope ? key(nextScope) : '')) localStorage.removeItem(name);
  }
});
