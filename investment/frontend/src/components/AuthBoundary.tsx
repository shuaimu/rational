import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { getAuthState, initializeAuth, signIn, signOut, subscribeAuth } from '../api/auth';
import { getSyncStatus, resetLocalData, startReplication, subscribeSync } from '../api/rxdb';

export function AuthBoundary({ children }: { children: ReactNode }) {
  const auth = useSyncExternalStore(subscribeAuth, getAuthState);
  const sync = useSyncExternalStore(subscribeSync, getSyncStatus);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void initializeAuth(); }, []);
  useEffect(() => {
    if (auth.status === 'ready') void startReplication().catch(() => setError('The local cloud cache could not start. Close other Rational Investment tabs and reload.'));
  }, [auth.status, auth.scope]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { await signIn(email.trim(), password); setPassword(''); }
    catch { setError('Sign-in failed. Check your application account and password.'); }
    finally { setBusy(false); }
  }
  if (auth.status === 'ready') return <>
    <div className="flex flex-wrap items-center justify-between gap-3 bg-indigo-950 px-4 py-2 text-sm text-white" role="status">
      <span>{auth.offline || sync.phase === 'offline' ? 'Offline — showing your saved portfolio' : sync.pendingVersion ? `Saved to cloud · syncing version ${sync.pendingVersion}` : sync.message ?? (sync.readable ? `Synced · version ${sync.version}` : 'Loading your cloud portfolio…')}</span>
      <div className="flex items-center gap-4">
        {sync.phase === 'error' && <button className="underline" onClick={() => void resetLocalData()}>Reload local data</button>}
        <a className="underline" href={import.meta.env.PROD ? "/rational/" : "/"}>Back to Rational</a><span>{auth.email}</span><button className="underline" onClick={() => void signOut().catch(() => setError('Local data could not be cleared. Close other tabs and retry.'))}>Sign out</button>
      </div>
    </div>
    {sync.readable ? children : <main className="mx-auto max-w-lg p-12 text-center"><h1 className="text-xl font-semibold">Loading your portfolio</h1><p className="mt-3 text-gray-600">{error ?? sync.message ?? 'The first synchronization includes your portfolio and price history. Your data will appear when the complete local view is ready.'}</p></main>}
  </>;
  if (auth.status === 'denied') return <main className="mx-auto max-w-lg p-12 text-center"><h1 className="text-2xl font-semibold">Rational Investment</h1><p className="my-6" role="alert">{auth.error}</p><a className="text-indigo-700 underline" href={import.meta.env.PROD ? '/rational/' : '/'}>Back to Rational</a><button className="ml-6 underline" onClick={() => void signOut()}>Sign out</button></main>;
  if (auth.status === 'starting' || auth.status === 'clearing') return <main className="p-12 text-center" role="status">{auth.status === 'clearing' ? 'Securing local data…' : 'Opening Rational Investment…'}</main>;
  return <main className="flex min-h-screen items-center justify-center bg-gray-100 px-4">
    <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold text-indigo-700">Rational Investment</h1><p className="mt-2 text-sm text-gray-600">Sign in to your portfolio.</p>
      <a className="mt-4 block rounded border border-indigo-600 px-4 py-2 text-center text-indigo-700" href={import.meta.env.PROD ? '/rational/' : '/'}>Continue with Rational</a>
      <p className="mt-2 text-xs text-gray-500">Use your Rational account, including Google sign-in, then open Investment.</p>
      <label className="mt-6 block text-sm font-medium" htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border border-gray-300 p-2" />
      <label className="mt-4 block text-sm font-medium" htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded border border-gray-300 p-2" />
      {(error || auth.error) && <p className="mt-4 text-sm text-red-700" role="alert">{error ?? auth.error}</p>}
      <button disabled={busy || auth.status === 'error'} className="mt-6 w-full rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
      {auth.status === 'error' && <button type="button" className="mt-4 text-sm underline" onClick={() => location.reload()}>Retry local cleanup</button>}
    </form>
  </main>;
}
