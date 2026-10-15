import makoConfig from './mako-config.json';
import { isCloudApi } from './runtime';
export { isCloudApi } from './runtime';
import { configureJobs, waitForJob, type CloudJob } from './jobs';
import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { auth, onClearProtectedState, requireOwnerScope, signOut } from './auth';
import { digest } from './manifest';
import { getSyncStatus, subscribeSync, waitForVersion } from './rxdb';

type Command = { scope: string; fingerprint: string; id: string };
type RequestConfig = InternalAxiosRequestConfig & { robinCommand?: Command; robinScope?: string; robinRenewed?: boolean; robinBusyRetries?: number; robinRetryBusy?: boolean };
const prefix = 'robinlab.commands.';
const journalKey = (scope: string) => prefix + encodeURIComponent(scope);
type Pending = { id: string; acceptedVersion?: number };
function commands(scope: string): Record<string, Pending> { return JSON.parse(localStorage.getItem(journalKey(scope)) ?? '{}'); }
function complete(command: Command) { const pending = commands(command.scope); if (pending[command.fingerprint]?.id === command.id) { delete pending[command.fingerprint]; localStorage.setItem(journalKey(command.scope), JSON.stringify(pending)); } }
onClearProtectedState(async (nextScope) => {
  for (const key of Object.keys(localStorage)) if (key.startsWith(prefix) && key !== (nextScope ? journalKey(nextScope) : '')) localStorage.removeItem(key);
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function requestBody(data: unknown): Promise<unknown> {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    return { bytes: bytes.byteLength, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('') };
  }
  if (!(data instanceof FormData)) return data ?? null;
  const values = [];
  for (const [key, value] of data.entries()) values.push([key, typeof value === 'string' ? value : { bytes: value.size, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()))].map((n) => n.toString(16).padStart(2, '0')).join('') }]);
  return values;
}
export class ApiRequestError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.status = status; this.name = 'ApiRequestError'; } }
export const api = axios.create({ baseURL: isCloudApi ? `${makoConfig.endpoint}/${makoConfig.projectId}--${makoConfig.environmentId}/functions/v1/robinlab-api` : '/api', timeout: isCloudApi ? 30_000 : 180_000 });
// Small status reads surface busy responses immediately; the UI owns their retry.
export function readStatus<T>(url: string, signal: AbortSignal) {
  const config: AxiosRequestConfig & { robinRetryBusy: boolean } = { signal, robinRetryBusy: false };
  return api.get<T>(url, config);
}
api.interceptors.request.use(async (request: RequestConfig) => {
  const scope = requireOwnerScope();
  request.robinScope = scope;
  if (isCloudApi) request.headers['x-mako-key'] = makoConfig.publicProjectKey;
  request.headers.Authorization = `Bearer ${await auth.validAccessToken()}`;
  if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
  if (!['get', 'head', 'options'].includes(request.method?.toLowerCase() ?? 'get')) {
    if (!request.robinCommand) {
      const fingerprint = await digest(canonical([request.method, request.url, request.params ?? null, await requestBody(request.data)]));
      const pending = commands(scope);
      const explicit = request.headers['Idempotency-Key'];
      const id = typeof explicit === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(explicit) ? explicit : pending[fingerprint]?.id ?? crypto.randomUUID();
      pending[fingerprint] = { id };
      // Record before sending, so a lost response or reload retries the same ID.
      localStorage.setItem(journalKey(scope), JSON.stringify(pending));
      request.robinCommand = { scope, fingerprint, id };
    }
    request.headers['Idempotency-Key'] = request.robinCommand.id;
  }
  return request;
});
api.interceptors.response.use(async (response) => {
  const request = response.config as RequestConfig;
  if (requireOwnerScope() !== request.robinScope) throw new Error('Application session changed.');
  if (response.status === 202 && typeof response.data?.id === 'string' && response.data.id.startsWith('j_')) {
    const result = await waitForJob(response.data as CloudJob, request.robinCommand);
    if (result.resumePath) return api.get(result.resumePath);
    response.data = result.response; response.status = 200;
    response.headers['x-robinlab-version'] = String(result.version);
  }
  const version = Number(response.headers['x-robinlab-version']);
  if (request.robinCommand && Number.isSafeInteger(version) && version > 0) {
    const command = request.robinCommand;
    const pending = commands(command.scope);
    pending[command.fingerprint] = { id: command.id, acceptedVersion: version };
    localStorage.setItem(journalKey(command.scope), JSON.stringify(pending));
    try { await waitForVersion(version); complete(request.robinCommand); }
    catch { /* The global sync banner retains the accepted version and retry ID. */ }
  } else if (request.robinCommand) complete(request.robinCommand);
  if (requireOwnerScope() !== request.robinScope) throw new Error('Application session changed.');
  return response;
}, async (error: unknown) => {
  if (!axios.isAxiosError(error)) throw error;
  const request = error.config as RequestConfig | undefined;
  if (isCloudApi && error.response?.status === 429 && request && request.robinRetryBusy !== false && (request.robinBusyRetries ?? 0) < 4) {
    const scope = request.robinScope;
    const attempt = request.robinBusyRetries = (request.robinBusyRetries ?? 0) + 1;
    const retryAfter = error.response.headers['retry-after'];
    const seconds = Number(retryAfter);
    const specified = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(String(retryAfter)) - Date.now();
    const delay = Math.min(15_000, Math.max(1000 * 2 ** (attempt - 1), Number.isFinite(specified) ? specified : 0));
    await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 500));
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    return api.request(request);
  }
  if (error.response?.status === 401 && request && !request.robinRenewed) {
    request.robinRenewed = true;
    await auth.refreshSession();
    return api.request(request);
  }
  if (error.response?.status === 401) { console.warn('Investment session reset', { source: 'api-after-renewal' }); await signOut(); }
  if (request?.robinCommand && error.response && [400, 404, 410, 413, 422].includes(error.response.status)) complete(request.robinCommand);
  // Axios errors carry headers and request bodies. Expose only a user message.
  const message = typeof error.response?.data?.error === 'string' ? error.response.data.error : !error.response ? 'The API is unavailable. Retry this operation when connected.' : `The request failed (${error.response.status}).`;
  throw new ApiRequestError(message, error.response?.status);
});

configureJobs({ list: cursor => api.get<{ jobs: CloudJob[]; cursor: string | null }>('/jobs', { params: cursor ? { cursor } : {} }).then(r => r.data), get: id => api.get<CloudJob>(`/jobs/${id}`).then(r => r.data), cancel: id => api.post<CloudJob>(`/jobs/${id}/cancel`).then(r => r.data), complete });

subscribeSync(() => {
  const status = getSyncStatus();
  if (!status.readable) return;
  let scope: string;
  try { scope = requireOwnerScope(); } catch { return; }
  for (const [fingerprint, pending] of Object.entries(commands(scope))) {
    if (pending.acceptedVersion && pending.acceptedVersion <= status.version) complete({ scope, fingerprint, id: pending.id });
  }
});
