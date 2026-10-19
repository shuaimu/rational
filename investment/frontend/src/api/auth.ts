import { SharedAuthClient, sessionKey as sharedSessionKey, sessionPersistence } from '../../../../shared/auth';
import { MakoAuthError, normalizeMakoRxdbConfig, type MakoUserSession } from '@mako-cloud/rxdb';
import config from './mako-config.json';
import { migratePendingOperations, PendingMigrationConflict } from './migration';

export { config as makoConfig };
export const collectionConfig = (collectionId: string) => normalizeMakoRxdbConfig({ ...config, collectionId, schemaVersion: 1, rxdbVersion: '17.4.0', runtime: 'browser', pullBatchSize: 20 });
const sessionKey = sharedSessionKey(config);
const persistence = sessionPersistence(collectionConfig('portfolio_heads'));
export type AuthState = { status: 'starting' | 'signed-out' | 'ready' | 'clearing' | 'error' | 'denied'; scope: string | null; email: string | null; offline: boolean; error: string | null };
let state: AuthState = { status: 'starting', scope: null, email: null, offline: !navigator.onLine, error: null };
const listeners = new Set<() => void>();
const clearHooks = new Set<(nextScope: string | null) => Promise<void>>();
let signingOut = false;
let logout: Promise<void> | undefined;
let transition = Promise.resolve();
let transitionEpoch = 0;
let initialization: Promise<void> | undefined;
let validation: Promise<void> | undefined;
export const getAuthState = () => state;
export const subscribeAuth = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(patch: Partial<AuthState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
export const onClearProtectedState = (hook: (nextScope: string | null) => Promise<void>) => { clearHooks.add(hook); return () => { clearHooks.delete(hook); }; };
const boundedFetch: typeof fetch = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });

// Only a cache namespace is derived from claims. HTTPS sign-in and /auth/user
// authenticate the session; the API independently checks the owner on every call.
export function sessionScope(session: MakoUserSession): string {
  const part = session.accessToken.split('.')[1];
  const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  if (session.user.id !== config.ownerId || session.user.status !== 'active' || claims.sub !== config.ownerId || claims.project_id !== config.projectId || claims.environment_id !== config.environmentId || !Number.isSafeInteger(claims.environment_authorization_epoch) || !Number.isSafeInteger(claims.user_authorization_epoch)) throw new Error('This account cannot access Rational Investment.');
  return JSON.stringify([config.endpoint, config.projectId, config.environmentId, config.ownerId, 1, claims.environment_authorization_epoch, claims.user_authorization_epoch]);
}

export const auth = new SharedAuthClient(collectionConfig('portfolio_heads'), { persistence, fetch: boundedFetch });

async function clearProtected(nextScope: string | null) { migratePendingOperations(localStorage, nextScope); for (const hook of clearHooks) await hook(nextScope); }
function adopt(session: MakoUserSession | null): Promise<void> {
  let scope: string | null = null;
  try { if (session) scope = sessionScope(session); }
  catch {
    const epoch = ++transitionEpoch;
    update({ status: 'clearing' });
    transition = transition.then(async () => {
      if (epoch !== transitionEpoch) return;
      await clearProtected(null);
      if (epoch === transitionEpoch) update({ status: 'denied', scope: null, email: session?.user.email ?? null, error: 'This account does not have access to Rational Investment.' });
    }).catch(() => update({ status: 'error', error: 'Local data could not be cleared. Close other tabs and retry.' }));
    return transition;
  }
  if (scope === state.scope && state.status === 'ready') return Promise.resolve();
  // Block rendering synchronously before any asynchronous cache removal.
  const epoch = ++transitionEpoch;
  update({ status: 'clearing' });
  transition = transition.then(async () => {
    if (epoch !== transitionEpoch) return;
    if (state.scope !== scope) await clearProtected(scope);
    if (epoch !== transitionEpoch) return;
    update({ status: session ? 'ready' : 'signed-out', scope, email: session?.user.email ?? null });
  }).catch((error) => { update({ status: 'error', error: error instanceof PendingMigrationConflict ? error.message : 'Local data could not be cleared. Close other Rational Investment tabs and retry.' }); });
  return transition;
}

auth.subscribe((event) => {
  if (!signingOut && (event.kind === 'session' || event.kind === 'signed_out')) void adopt(event.session);
  if (event.kind === 'refresh_unavailable') update({ offline: true });
  if (event.kind === 'refresh_recovered') update({ offline: false });
});
window.addEventListener('offline', () => update({ offline: true }));
window.addEventListener('online', () => { update({ offline: false }); void validateSession().catch(() => {}); });
window.addEventListener('storage', (event) => {
  if (event.key !== sessionKey) return;
  if (event.newValue === null) update({ status: 'clearing' });
  void auth.restoreSession().then(adopt);
});

// Renewal proves whether the refresh session is still accepted. A rejected
// access token or an authorization-epoch change alone is not a sign-out.
export async function renewSession(): Promise<void> {
  try {
    const session = await auth.refreshSession();
    await adopt(session);
  } catch (error) {
    if (auth.authenticationRequired) await adopt(null);
    throw error;
  }
}

export function validateSession(): Promise<void> {
  validation ??= validateCurrentSession().finally(() => { validation = undefined; });
  return validation;
}
async function validateCurrentSession(): Promise<void> {
  try {
    const readUser = async () => {
      const token = await auth.validAccessToken();
      const response = await boundedFetch(`${config.endpoint}/v1/projects/${config.projectId}/environments/${config.environmentId}/auth/user`, { headers: { Authorization: `Bearer ${token}`, 'X-Mako-Key': config.publicProjectKey } });
      return { token, response };
    };
    let result = await readUser();
    if ([401, 403].includes(result.response.status)) {
      // A sleeping tab can resume with an expired token; another tab may also
      // have rotated it while this request was in flight.
      if (auth.accessToken() === result.token) await renewSession();
      result = await readUser();
    }
    if (auth.accessToken() !== result.token) return;
    const { response } = result;
    if (!response.ok) { update({ offline: true }); return; }
    const user = await response.json();
    if (user.status !== 'active') { await renewSession(); return; }
    if (user.id !== config.ownerId) { await adopt(auth.currentSession()); return; }
    update({ offline: false });
  } catch (error) {
    if (error instanceof MakoAuthError && !error.retryable && auth.authenticationRequired) await adopt(null);
    else update({ offline: true });
  }
}
export function initializeAuth(): Promise<void> {
  if (!initialization) initialization = (async () => {
    const session = await auth.restoreSession();
    await adopt(session);
    if (session) void validateSession();
  })().catch(() => update({ status: 'error', error: 'Local sign-in could not be restored. Reload to retry.' }));
  return initialization;
}
export async function signIn(email: string, password: string): Promise<void> {
  update({ error: null });
  const session = await auth.signInWithPassword(email, password);
  await adopt(session);
  await validateSession();
}
export function signOut(): Promise<void> {
  if (!logout) logout = performSignOut().finally(() => { logout = undefined; });
  return logout;
}
async function performSignOut(): Promise<void> {
  signingOut = true;
  ++transitionEpoch;
  update({ status: 'clearing' });
  try {
    await transition;
    await clearProtected(null);
  } catch {
    signingOut = false;
    update({ status: 'error', scope: null, email: null, error: 'Close other Rational Investment tabs and reload to finish clearing local data.' });
    return;
  }
  const end = async () => { try { await auth.signOut(); } catch { /* Local access ends even while offline. */ } };
  await end();
  signingOut = false;
  await adopt(null);
}
export function requireOwnerScope(): string {
  if (state.status !== 'ready' || !state.scope) throw new Error('Sign in to view your portfolio.');
  return state.scope;
}

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
