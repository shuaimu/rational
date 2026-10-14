import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '../api/client';

export function Performance() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['accounts-performance'],
    queryFn: analyticsApi.accountsPerformance,
  });

  const rows = useMemo(() => {
    return [...(data ?? [])].sort((a, b) => b.total_value - a.total_value);
  }, [data]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          totalValue: acc.totalValue + row.total_value,
          brokerValue: acc.brokerValue + (row.broker_balance ?? 0),
          totalCost: acc.totalCost + row.total_cost,
          totalDeposit: acc.totalDeposit + row.total_deposit,
          totalProfit: acc.totalProfit + row.profit,
        }),
        { totalValue: 0, brokerValue: 0, totalCost: 0, totalDeposit: 0, totalProfit: 0 },
      ),
    [rows],
  );

  const hasBrokerValue = useMemo(() => rows.some((row) => row.broker_balance != null), [rows]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Performance</h1>
      </div>

      {isLoading ? (
        <div className="text-gray-500">Loading...</div>
      ) : isError ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          Failed to load account performance: {(error as Error).message}
        </div>
      ) : (
        <>
          <div className={`grid grid-cols-1 gap-5 sm:grid-cols-2 ${hasBrokerValue ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Computed Value</div>
              <div className="mt-1 text-xl font-semibold text-gray-900">
                {formatCurrency(totals.totalValue)}
              </div>
              <div className="mt-1 text-xs text-gray-400">positions + cash ledger</div>
            </div>
            {hasBrokerValue && (
              <div className="rounded-lg bg-white p-5 shadow">
                <div className="text-sm text-gray-500">Broker Value</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">
                  {formatCurrency(totals.brokerValue)}
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  Δ {formatCurrency(totals.totalValue - totals.brokerValue)} vs computed
                </div>
              </div>
            )}
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Total Cost</div>
              <div className="mt-1 text-xl font-semibold text-gray-900">
                {formatCurrency(totals.totalCost)}
              </div>
            </div>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Total Deposit</div>
              <div className="mt-1 text-xl font-semibold text-gray-900">
                {formatCurrency(totals.totalDeposit)}
              </div>
            </div>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Total Profit</div>
              <div className={`mt-1 text-xl font-semibold ${totals.totalProfit < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {formatCurrency(totals.totalProfit)}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white shadow">
            <div className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
              Per-Account Metrics
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Account
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Open Positions
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Computed Value
                    </th>
                    {hasBrokerValue && (
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Broker Value
                      </th>
                    )}
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Total Cost
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Total Deposit
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Profit
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Annual Yield
                    </th>
                    <th
                      className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500"
                      title="Trailing-12-month money-weighted return (XIRR)"
                    >
                      Last 12M Return
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white text-sm">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={hasBrokerValue ? 9 : 8} className="px-4 py-6 text-center text-gray-500">
                        No account data available.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.account_id}>
                        <td className="px-4 py-2 font-medium text-gray-900">{row.account_code}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{row.open_positions}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(row.total_value)}</td>
                        {hasBrokerValue && (
                          <td className="px-4 py-2 text-right text-gray-900">
                            {row.broker_balance != null ? (
                              <span title={`Δ ${formatCurrency(row.total_value - row.broker_balance)} vs computed`}>
                                {formatCurrency(row.broker_balance)}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(row.total_cost)}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(row.total_deposit)}</td>
                        <td className={`px-4 py-2 text-right font-medium ${row.profit < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                          {formatCurrency(row.profit)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-medium ${
                            row.annual_yield_rate < 0 ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {formatPercent(row.annual_yield_rate)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-medium ${
                            row.last_12m_profit_rate == null
                              ? 'text-gray-400'
                              : row.last_12m_profit_rate < 0
                                ? 'text-red-600'
                                : 'text-emerald-700'
                          }`}
                        >
                          {row.last_12m_profit_rate == null
                            ? '—'
                            : formatPercent(row.last_12m_profit_rate)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
