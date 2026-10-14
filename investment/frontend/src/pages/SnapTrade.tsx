import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { snaptradeApi, accountsApi } from '../api/client';
import type { SnapTradeImportResult } from '../api/types';

function errMsg(e: unknown): string {
  const anyErr = e as { response?: { data?: { error?: string } }; message?: string };
  return anyErr?.response?.data?.error ?? anyErr?.message ?? String(e);
}

function relativeTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleString();
}

function syncDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function Spinner() {
  return (
    <svg
      className="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

export function SnapTrade() {
  const queryClient = useQueryClient();
  const [importResult, setImportResult] = useState<SnapTradeImportResult | null>(null);
  const [importMode, setImportMode] = useState<'preview' | 'apply' | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  // snaptrade_account_id -> selected RobinLab account id (for the link dropdowns)
  const [linkSel, setLinkSel] = useState<Record<string, number>>({});

  // Connected brokerage accounts are loaded on demand (each call hits SnapTrade).
  const accountsQuery = useQuery({
    queryKey: ['snaptrade-accounts'],
    queryFn: snaptradeApi.accounts,
    enabled: false,
    retry: false,
  });

  const robinAccounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list });

  // Persisted last-sync time (reflects the hourly background syncs + prior sessions).
  const statusQuery = useQuery({
    queryKey: ['snaptrade-status'],
    queryFn: snaptradeApi.status,
    refetchInterval: 60_000,
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      await snaptradeApi.register();
      const { redirect_uri } = await snaptradeApi.connect();
      return redirect_uri;
    },
    onSuccess: (uri) => window.open(uri, '_blank', 'noopener,noreferrer'),
  });

  const linkMutation = useMutation({
    mutationFn: ({ sid, accountId }: { sid: string; accountId: number }) =>
      snaptradeApi.link(sid, accountId),
    onSuccess: () => accountsQuery.refetch(),
  });

  const importMutation = useMutation({
    mutationFn: (apply: boolean) => snaptradeApi.import(apply ? { apply: true } : {}),
    // Set the mode at the START of the request so the in-progress hint reflects
    // the in-flight call (not the previous result), and clear any stale output.
    onMutate: (apply) => {
      setImportResult(null);
      setImportMode(apply ? 'apply' : 'preview');
    },
    onSuccess: (data, apply) => {
      setImportResult(data);
      setImportMode(apply ? 'apply' : 'preview');
      if (apply) {
        setLastSyncedAt(new Date());
        queryClient.invalidateQueries();
      }
    },
  });

  const accounts = accountsQuery.data ?? [];

  // Prefer a just-happened in-session sync; else the persisted time from the
  // backend. Retain explicit timezones and interpret legacy unzoned values as UTC.
  const persistedSyncedAt = syncDate(statusQuery.data?.last_synced_at);
  const displaySyncedAt = lastSyncedAt ?? persistedSyncedAt;

  const btn =
    'inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSecondary =
    'inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Brokers (SnapTrade)</h1>

      {/* 1. Connect */}
      <div className="bg-white shadow rounded-lg p-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Connect a broker</h3>
          <p className="mt-1 text-sm text-gray-600">
            Opens SnapTrade's secure portal in a new tab. Sign in to your broker there, then come
            back and refresh the connected accounts below. The portal link expires after ~5 minutes.
          </p>
        </div>
        <button
          onClick={() => connectMutation.mutate()}
          disabled={connectMutation.isPending}
          className={btn}
        >
          {connectMutation.isPending ? 'Opening portal…' : 'Connect a broker'}
        </button>
        {connectMutation.isError && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            Error: {errMsg(connectMutation.error)}
          </div>
        )}
        {connectMutation.isSuccess && (
          <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-700">
            Portal opened in a new tab. After linking your broker there, click{' '}
            <strong>Refresh</strong> below.
          </div>
        )}
      </div>

      {/* 2. Connected accounts */}
      <div className="bg-white shadow rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-gray-900">Connected accounts</h3>
          <button
            onClick={() => accountsQuery.refetch()}
            disabled={accountsQuery.isFetching}
            className={btnSecondary}
          >
            {accountsQuery.isFetching ? 'Loading…' : accountsQuery.isFetched ? 'Refresh' : 'Load accounts'}
          </button>
        </div>

        {accountsQuery.isError && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            Error: {errMsg(accountsQuery.error)}
          </div>
        )}

        {accountsQuery.isFetched && accounts.length === 0 && !accountsQuery.isError && (
          <p className="text-sm text-gray-500">
            No connected accounts yet. Use “Connect a broker” above.
          </p>
        )}

        {accounts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-2 pr-4 font-medium">Broker</th>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">RobinLab account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {accounts.map((a) => (
                  <tr key={a.snaptrade_account_id}>
                    <td className="py-2 pr-4 text-gray-900">{a.institution_name ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-700">{a.name ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-500">{a.number ?? '—'}</td>
                    <td className="py-2 pr-4">
                      {a.linked_account_code ? (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                          {a.linked_account_code}
                        </span>
                      ) : (
                        <div className="flex items-center space-x-2">
                          <select
                            value={linkSel[a.snaptrade_account_id] ?? ''}
                            onChange={(e) =>
                              setLinkSel((s) => ({
                                ...s,
                                [a.snaptrade_account_id]: Number(e.target.value),
                              }))
                            }
                            className="rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                          >
                            <option value="">Choose account…</option>
                            {(robinAccounts.data ?? []).map((acct) => (
                              <option key={acct.id} value={acct.id}>
                                {acct.code}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() =>
                              linkMutation.mutate({
                                sid: a.snaptrade_account_id,
                                accountId: linkSel[a.snaptrade_account_id],
                              })
                            }
                            disabled={!linkSel[a.snaptrade_account_id] || linkMutation.isPending}
                            className={btnSecondary}
                          >
                            Link
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {linkMutation.isError && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            Error: {errMsg(linkMutation.error)}
          </div>
        )}
      </div>

      {/* 3. Sync */}
      <div className="bg-white shadow rounded-lg p-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Sync transactions</h3>
          <p className="mt-1 text-sm text-gray-600">
            Pulls new activity for every linked account (from each account's last-synced point),
            reconstructs option rolls, and imports. Runs automatically in the background too;
            use this to sync on demand.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => importMutation.mutate(false)}
            disabled={importMutation.isPending}
            className={btnSecondary}
          >
            {importMutation.isPending && importMode === 'preview' ? (
              <>
                <Spinner />
                Previewing…
              </>
            ) : (
              'Preview'
            )}
          </button>
          <button
            onClick={() => importMutation.mutate(true)}
            disabled={importMutation.isPending}
            className={btn}
          >
            {importMutation.isPending && importMode === 'apply' ? (
              <>
                <Spinner />
                Syncing…
              </>
            ) : (
              'Sync now'
            )}
          </button>
          {displaySyncedAt && !importMutation.isPending && (
            <span className="text-xs text-gray-400" title={displaySyncedAt.toLocaleString()}>
              Last synced {relativeTime(displaySyncedAt)}
            </span>
          )}
        </div>

        {importMutation.isPending && (
          <div className="flex items-center rounded-md bg-blue-50 p-4 text-sm text-blue-700">
            <Spinner />
            {importMode === 'apply'
              ? 'Syncing… pulling new activity from your brokers, reconstructing option rolls, and importing. This can take up to a minute. Leaving now just cancels this run — it writes all-or-nothing and is safe to re-run.'
              : 'Building preview… reading activity from your brokers without writing anything.'}
          </div>
        )}

        {importMutation.isError && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
            Error: {errMsg(importMutation.error)}
          </div>
        )}

        {importResult && importMode === 'apply' && importResult.applied && (
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
            <p className="font-medium">
              ✓ Sync complete{lastSyncedAt ? ` at ${lastSyncedAt.toLocaleTimeString()}` : ''}.
            </p>
            <ul className="mt-2 list-disc list-inside">
              <li>Transactions imported: {importResult.plain_legs_imported}</li>
              <li>Rolls reconstructed: {importResult.rolls_reconstructed}</li>
              <li>Rolls already present (skipped): {importResult.rolls_already_present}</li>
              <li>Rolls kept as raw legs: {importResult.rolls_fallback_raw}</li>
              <li>Historical stock legs marked closed: {importResult.historical_stock_legs_closed}</li>
              <li>New accounts / tickers: {importResult.accounts_created} / {importResult.tickers_created}</li>
            </ul>
          </div>
        )}

        {importResult && importMode === 'preview' && (
          <div className="rounded-md bg-blue-50 p-4 text-sm text-blue-700">
            <p className="font-medium">Preview (nothing written).</p>
            <ul className="mt-2 list-disc list-inside">
              <li>New legs to import: {importResult.total_legs}</li>
              <li>Rolls detected: {importResult.rolls_detected}</li>
              <li>Would reconstruct: {importResult.rolls_reconstructed}</li>
              <li>Would keep as raw legs: {importResult.rolls_fallback_raw}</li>
              <li>Plain legs to upsert: {importResult.plain_legs_to_upsert}</li>
            </ul>
            {importResult.per_account && importResult.per_account.length > 0 && (
              <p className="mt-2">
                Window:{' '}
                {importResult.per_account
                  .map((p) =>
                    p.earliest ? `${p.account} ${p.earliest}→${p.latest}` : `${p.account} (none)`,
                  )
                  .join(', ')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
