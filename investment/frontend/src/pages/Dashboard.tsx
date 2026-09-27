import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { accountsApi, analyticsApi, positionsApi } from '../api/client';
import type { AccountPerformance, Position } from '../api/types';
import { AggregatedPositionTable } from '../components/AggregatedPositionTable';
import { getAccountCategory, getAccountCategoryTitle } from '../utils/accountCategory';
import { isoDateYearsAgo } from '../utils/date';

const EMPTY_POSITIONS: Position[] = [];
const EMPTY_ACCOUNT_PERFORMANCE: AccountPerformance[] = [];

export function Dashboard() {
  const [showClosedLots, setShowClosedLots] = useState(false);

  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['summary'],
    queryFn: analyticsApi.summary,
  });

  const { data: yieldMetrics, isLoading: yieldLoading } = useQuery({
    queryKey: ['yield-metrics'],
    queryFn: analyticsApi.yield,
  });

  const { data: accountsPerformance, isLoading: accountsPerformanceLoading } = useQuery({
    queryKey: ['accounts-performance'],
    queryFn: analyticsApi.accountsPerformance,
  });

  const { data: openPositions, isLoading: openPositionsLoading } = useQuery({
    queryKey: ['positions', { includeClosed: false }],
    queryFn: () => positionsApi.list(false),
  });

  const { data: positions, isLoading: positionsLoading } = useQuery({
    queryKey: ['positions', { includeClosed: showClosedLots }],
    queryFn: () => positionsApi.list(showClosedLots),
  });

  const basePositions = openPositions ?? EMPTY_POSITIONS;
  const accountRows = accountsPerformance ?? EMPTY_ACCOUNT_PERFORMANCE;
  const totalValue = accountRows.reduce((sum, row) => sum + row.total_value, 0);
  const hasBrokerValue = accountRows.some((row) => row.broker_balance != null);
  const brokerValue = accountRows.reduce((sum, row) => sum + (row.broker_balance ?? 0), 0);
  const totalDeposit = accountRows.reduce((sum, row) => sum + row.total_deposit, 0);
  const profit = accountRows.reduce((sum, row) => sum + row.profit, 0);
  const annualYieldRate = yieldMetrics?.annual_yield_rate ?? 0;
  const oneYearAgoStr = isoDateYearsAgo(1);

  const categorizedAccounts = useMemo(() => {
    const stockIds = new Set<number>();
    const indexIds = new Set<number>();
    const stockCodes: string[] = [];
    const indexCodes: string[] = [];

    for (const account of accounts ?? []) {
      const category = getAccountCategory(account);
      if (category === 'index') {
        indexIds.add(account.id);
        indexCodes.push(account.code);
      } else {
        stockIds.add(account.id);
        stockCodes.push(account.code);
      }
    }

    return { stockIds, indexIds, stockCodes, indexCodes };
  }, [accounts]);

  const categorySections = useMemo(() => {
    const currentPositions = positions ?? [];
    const currentOpenPositions = openPositions ?? [];
    const stockPositions = currentPositions.filter((pos) => categorizedAccounts.stockIds.has(pos.account_id));
    const indexPositions = currentPositions.filter((pos) => categorizedAccounts.indexIds.has(pos.account_id));
    const stockOpenPositions = currentOpenPositions.filter((pos) =>
      categorizedAccounts.stockIds.has(pos.account_id)
    );
    const indexOpenPositions = currentOpenPositions.filter((pos) =>
      categorizedAccounts.indexIds.has(pos.account_id)
    );

    const stockRows = accountRows.filter((row) => categorizedAccounts.stockIds.has(row.account_id));
    const indexRows = accountRows.filter((row) => categorizedAccounts.indexIds.has(row.account_id));

    const summarizeRows = (rows: typeof accountRows, categoryLots: typeof currentOpenPositions) => {
      const last12mLots = categoryLots.filter((pos) => (pos.opened_date ?? '') >= oneYearAgoStr);
      const last12mCost = last12mLots.reduce((sum, pos) => sum + pos.total_cost, 0);
      const last12mProfit = last12mLots.reduce((sum, pos) => sum + (pos.total_value - pos.total_cost), 0);

      return {
        accounts: rows.length,
        openPositions: categoryLots.length,
        tickers: new Set(categoryLots.map((pos) => pos.ticker_id)).size,
        totalValue: rows.reduce((sum, row) => sum + row.total_value, 0),
        totalDeposit: rows.reduce((sum, row) => sum + row.total_deposit, 0),
        profit: rows.reduce((sum, row) => sum + row.profit, 0),
        last12mProfitRate: last12mCost !== 0 ? (last12mProfit / Math.abs(last12mCost)) * 100 : 0,
      };
    };

    return [
      {
        key: 'stock',
        title: getAccountCategoryTitle('stock'),
        accountCodes: categorizedAccounts.stockCodes,
        positions: stockPositions,
        summary: summarizeRows(stockRows, stockOpenPositions),
      },
      {
        key: 'index',
        title: getAccountCategoryTitle('index'),
        accountCodes: categorizedAccounts.indexCodes,
        positions: indexPositions,
        summary: summarizeRows(indexRows, indexOpenPositions),
      },
    ] as const;
  }, [positions, openPositions, accountRows, categorizedAccounts, oneYearAgoStr]);

  const last12mLots = basePositions.filter((pos) => (pos.opened_date ?? '') >= oneYearAgoStr);
  const last12mCost = last12mLots.reduce((sum, pos) => sum + pos.total_cost, 0);
  const last12mProfit = last12mLots.reduce((sum, pos) => sum + (pos.total_value - pos.total_cost), 0);
  const last12mProfitRate = last12mCost !== 0 ? (last12mProfit / Math.abs(last12mCost)) * 100 : 0;

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  const categoryLoading =
    positionsLoading || accountsLoading || accountsPerformanceLoading || openPositionsLoading;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              checked={showClosedLots}
              onChange={(e) => setShowClosedLots(e.target.checked)}
            />
            Show closed lots
          </label>
        </div>

        {categorySections.map((section) => (
          <div key={section.key} className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:px-6 border-b border-gray-200">
              <h3 className="text-lg leading-6 font-medium text-gray-900">{section.title}</h3>
              <p className="mt-1 text-xs text-gray-500">
                Accounts:{' '}
                {section.accountCodes.length > 0 ? section.accountCodes.join(', ') : 'None'}
              </p>
            </div>
            {categoryLoading ? (
              <div className="p-4 text-gray-500">Loading...</div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 border-b border-gray-200 bg-gray-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Total Value
                      </div>
                      <div className="mt-2 text-xl font-semibold text-gray-900">
                        {formatCurrency(section.summary.totalValue)}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Total Deposit
                      </div>
                      <div className="mt-2 text-xl font-semibold text-gray-900">
                        {formatCurrency(section.summary.totalDeposit)}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Profit
                      </div>
                      <div
                        className={`mt-2 text-xl font-semibold ${
                          section.summary.profit < 0 ? 'text-red-600' : 'text-gray-900'
                        }`}
                      >
                        {formatCurrency(section.summary.profit)}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Last 12M Profit Rate
                      </div>
                      <div
                        className={`mt-2 text-xl font-semibold ${
                          section.summary.last12mProfitRate < 0 ? 'text-red-600' : 'text-gray-900'
                        }`}
                      >
                        {formatPercent(section.summary.last12mProfitRate)}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Open Positions
                      </div>
                      <div className="mt-2 text-xl font-semibold text-gray-900">
                        {section.summary.openPositions}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Tickers
                      </div>
                      <div className="mt-2 text-xl font-semibold text-gray-900">
                        {section.summary.tickers}
                      </div>
                    </div>
                  </div>
                  <div className="bg-white overflow-hidden shadow-sm rounded-lg">
                    <div className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                        Accounts
                      </div>
                      <div className="mt-2 text-xl font-semibold text-gray-900">
                        {section.summary.accounts}
                      </div>
                    </div>
                  </div>
                </div>

                {section.positions.length > 0 ? (
                  <AggregatedPositionTable positions={section.positions} />
                ) : (
                  <div className="p-4 text-gray-500">No positions in this category</div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {summaryLoading ? (
        <div className="text-gray-500">Loading...</div>
      ) : summary ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-indigo-100 rounded-md flex items-center justify-center">
                    <span className="text-indigo-600 text-xl">$</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Value</dt>
                    <dd className="text-lg font-semibold text-gray-900">
                      {accountsPerformanceLoading ? 'Loading...' : formatCurrency(totalValue)}
                    </dd>
                    {hasBrokerValue && !accountsPerformanceLoading && (
                      <dd className="text-xs text-gray-400" title="Broker-reported net liquidation (cross-check)">
                        Broker: {formatCurrency(brokerValue)}
                      </dd>
                    )}
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-sky-100 rounded-md flex items-center justify-center">
                    <span className="text-sky-600 text-xl">D</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Total Deposit</dt>
                    <dd className="text-lg font-semibold text-gray-900">
                      {accountsPerformanceLoading ? 'Loading...' : formatCurrency(totalDeposit)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-emerald-100 rounded-md flex items-center justify-center">
                    <span className="text-emerald-600 text-xl">P</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Profit</dt>
                    <dd className={`text-lg font-semibold ${profit < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                      {accountsPerformanceLoading ? 'Loading...' : formatCurrency(profit)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-cyan-100 rounded-md flex items-center justify-center">
                    <span className="text-cyan-600 text-xl">Y</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Annual Yield Rate</dt>
                    <dd className={`text-lg font-semibold ${annualYieldRate < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                      {yieldLoading ? 'Loading...' : formatPercent(annualYieldRate)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-orange-100 rounded-md flex items-center justify-center">
                    <span className="text-orange-600 text-xl">12</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Last 12M Profit Rate</dt>
                    <dd className={`text-lg font-semibold ${last12mProfitRate < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                      {openPositionsLoading ? 'Loading...' : formatPercent(last12mProfitRate)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-green-100 rounded-md flex items-center justify-center">
                    <span className="text-green-600 text-xl">#</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Open Positions</dt>
                    <dd className="text-lg font-semibold text-gray-900">{summary.total_positions}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-blue-100 rounded-md flex items-center justify-center">
                    <span className="text-blue-600 text-xl">A</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Accounts</dt>
                    <dd className="text-lg font-semibold text-gray-900">{summary.accounts_count}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-yellow-100 rounded-md flex items-center justify-center">
                    <span className="text-yellow-600 text-xl">T</span>
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">Tickers</dt>
                    <dd className="text-lg font-semibold text-gray-900">{summary.tickers_count}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
