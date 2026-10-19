type RefreshStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RefreshAttempt = { credentialDigest: string; requestId: string };

/** Keep a rotation's identity until its replacement credential is persisted.
 * A lost response, reload, or sleeping laptop must retry the same operation.
 * SharedAuthClient's browser lock serializes access across both applications.
 */
export function retryableRefreshFetch(
  fetch: typeof globalThis.fetch,
  key: string,
  storage: RefreshStorage | null,
): typeof globalThis.fetch {
  let pending: RefreshAttempt | null = null;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith('/auth/token') || init?.method !== 'POST' || typeof init.body !== 'string') {
      return fetch(input, init);
    }
    const body = JSON.parse(init.body) as { refreshToken: string };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.refreshToken));
    const credentialDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const raw = storage?.getItem(key);
    const previous: RefreshAttempt | null = storage ? (raw ? JSON.parse(raw) : null) : pending;
    if (previous?.credentialDigest === credentialDigest && typeof previous.requestId === 'string') {
      pending = previous;
    } else {
      pending = { credentialDigest, requestId: crypto.randomUUID() };
      // Fail before sending if durable storage fails. Retrying a rotation
      // whose identity was never saved could otherwise revoke the session.
      storage?.setItem(key, JSON.stringify(pending));
    }
    return fetch(input, { ...init, body: JSON.stringify({ ...body, requestId: pending.requestId }) });
  };
}
