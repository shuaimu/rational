import { useQuery } from '@tanstack/react-query';
import { positionsApi, accountsApi, analyticsApi } from '../api/client';
import type { Position } from '../api/types';
import { AggregatedPositionTable } from '../components/AggregatedPositionTable';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AccountCategory } from '../utils/accountCategory';
import { getAccountCategory } from '../utils/accountCategory';
import { getOptionStockImplication, netConversions } from '../utils/positionImplication';
import { getLeverage, getUnderlyingLabel } from '../utils/leverageMap';

const PIE_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#be123c',
  '#65a30d',
  '#c2410c',
  '#4338ca',
  '#0f766e',
];

interface PieSlice {
  label: string;
  value: number;
  color: string;
  accountPercent: number | null;
  normalizedPercent: number;
}

interface GroupedPositionRow {
  tickerSymbol: string;
  underlyingSymbol: string;
  componentMultipliers: Map<string, number>;
  totalValue: number;
  currentPrice: number | null;
  stockQuantity: number;
  likelyBuyQuantity: number;
  likelySellQuantity: number;
  potentialIBuyQuantity: number;
  potentialISellQuantity: number;
  unlikelyBuyQuantity: number;
  unlikelySellQuantity: number;
  effectiveExposure: number;
  potentialIExposure: number;
  potentialIIExposure: number;
}

type AccountCategoryFilter = 'all' | AccountCategory;

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function buildGroupedPositions(positions: Position[]): GroupedPositionRow[] {
  const grouped = new Map<string, GroupedPositionRow>();

  for (const pos of positions) {
    const { underlying, multiplier } = getLeverage(pos.ticker_symbol);
    const key = `underlying:${underlying}`;
    const existing = grouped.get(key);
    const implication = getOptionStockImplication(pos);
    const stockQuantity = pos.option_code ? 0 : pos.quantity;
    const adjustedStockQuantity = stockQuantity * multiplier;
    const adjustedLikelyBuy = implication.likelyBuy * multiplier;
    const adjustedLikelySell = implication.likelySell * multiplier;
    const adjustedPotentialIBuy = implication.potentialIBuy * multiplier;
    const adjustedPotentialISell = implication.potentialISell * multiplier;
    const adjustedUnlikelyBuy = implication.unlikelyBuy * multiplier;
    const adjustedUnlikelySell = implication.unlikelySell * multiplier;
    const effectiveQty = stockQuantity + implication.likelyBuy - implication.likelySell;
    const potentialIQty = stockQuantity + implication.potentialIBuy - implication.potentialISell;
    const potentialIIQty = stockQuantity + implication.likelyBuy + implication.unlikelyBuy;
    const effectiveExposure = pos.current_price != null ? pos.current_price * effectiveQty * multiplier : 0;
    const potentialIExposure = pos.current_price != null ? pos.current_price * potentialIQty * multiplier : 0;
    const potentialIIExposure = pos.current_price != null ? pos.current_price * potentialIIQty * multiplier : 0;

    if (existing) {
      existing.totalValue += pos.total_value;
      existing.stockQuantity += adjustedStockQuantity;
      existing.likelyBuyQuantity += adjustedLikelyBuy;
      existing.likelySellQuantity += adjustedLikelySell;
      existing.potentialIBuyQuantity += adjustedPotentialIBuy;
      existing.potentialISellQuantity += adjustedPotentialISell;
      existing.unlikelyBuyQuantity += adjustedUnlikelyBuy;
      existing.unlikelySellQuantity += adjustedUnlikelySell;
      existing.effectiveExposure += effectiveExposure;
      existing.potentialIExposure += potentialIExposure;
      existing.potentialIIExposure += potentialIIExposure;
      const isNewComponent = !existing.componentMultipliers.has(pos.ticker_symbol);
      existing.componentMultipliers.set(pos.ticker_symbol, multiplier);
      if (isNewComponent) {
        existing.currentPrice = null;
      } else if (existing.currentPrice == null && existing.componentMultipliers.size === 1 && pos.current_price != null) {
        existing.currentPrice = pos.current_price;
      }
      continue;
    }

    grouped.set(key, {
      tickerSymbol: underlying,
      underlyingSymbol: underlying,
      componentMultipliers: new Map([[pos.ticker_symbol, multiplier]]),
      totalValue: pos.total_value,
      currentPrice: pos.current_price,
      stockQuantity: adjustedStockQuantity,
      likelyBuyQuantity: adjustedLikelyBuy,
      likelySellQuantity: adjustedLikelySell,
      potentialIBuyQuantity: adjustedPotentialIBuy,
      potentialISellQuantity: adjustedPotentialISell,
      unlikelyBuyQuantity: adjustedUnlikelyBuy,
      unlikelySellQuantity: adjustedUnlikelySell,
      effectiveExposure,
      potentialIExposure,
      potentialIIExposure,
    });
  }

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      tickerSymbol: getUnderlyingLabel(row.underlyingSymbol, Array.from(row.componentMultipliers.keys())),
    }))
    .sort((a, b) => Math.abs(b.effectiveExposure) - Math.abs(a.effectiveExposure));
}

function buildPieBackground(pieSlices: PieSlice[]): string {
  if (!pieSlices.length) {
    return '';
  }

  let start = 0;
  const stops = pieSlices.map((slice) => {
    const from = start * 100;
    start += slice.normalizedPercent;
    const to = start * 100;
    return `${slice.color} ${from}% ${to}%`;
  });

  if (start < 1 - 1e-8) {
    stops.push(`#d1d5db ${start * 100}% 100%`);
  }

  return `conic-gradient(${stops.join(', ')})`;
}

function buildPositionSummary(positions: Position[], percentageDenominator: number | null) {
  // Exposure nets matched conversions (long put + short call locking a sale) against stock.
  const groupedPositions = buildGroupedPositions(netConversions(positions));
  const totalPotentialIValue = groupedPositions.reduce((sum, row) => sum + row.potentialIExposure, 0);
  const totalPotentialIIValue = groupedPositions.reduce((sum, row) => sum + row.potentialIIExposure, 0);

  const hasDenominator =
    percentageDenominator != null &&
    Number.isFinite(percentageDenominator) &&
    Math.abs(percentageDenominator) > 1e-8;
  const totalPotentialIPercent = hasDenominator ? totalPotentialIValue / percentageDenominator : null;
  const totalPotentialIIPercent = hasDenominator ? totalPotentialIIValue / percentageDenominator : null;

  if (!groupedPositions.length) {
    return {
      effectivePositionPercent: 0,
      totalPotentialIPercent,
      totalPotentialIIPercent,
      usedPercent: 0,
      unusedPercent: hasDenominator ? 1 : 0,
      pieSlices: [] as PieSlice[],
      excludedCount: 0,
      isLeveragedView: false,
      pieBackground: '',
    };
  }

  const positiveRows = groupedPositions
    .map((row) => {
      return { ...row, effectiveValue: row.effectiveExposure };
    })
    .filter((row) => row.effectiveValue > 0);
  const excludedCount = groupedPositions.length - positiveRows.length;
  const positiveTotal = positiveRows.reduce((sum, row) => sum + row.effectiveValue, 0);
  const effectivePositionPercent = hasDenominator ? positiveTotal / percentageDenominator : null;
  const isLeveragedView = hasDenominator && positiveTotal > percentageDenominator;
  const usedPercent = hasDenominator ? positiveTotal / percentageDenominator : null;
  const unusedPercent =
    hasDenominator && !isLeveragedView
      ? Math.max(percentageDenominator - positiveTotal, 0) / percentageDenominator
      : 0;

  const pieSlices: PieSlice[] = positiveRows.map((row, index) => ({
    label: row.tickerSymbol,
    value: row.effectiveValue,
    color: PIE_COLORS[index % PIE_COLORS.length],
    accountPercent: hasDenominator ? row.effectiveValue / percentageDenominator : null,
    normalizedPercent: 0,
  }));

  const totalForPie = pieSlices.reduce((sum, slice) => sum + slice.value, 0);
  if (totalForPie <= 0) {
    return {
      effectivePositionPercent,
      totalPotentialIPercent,
      totalPotentialIIPercent,
      usedPercent,
      unusedPercent,
      pieSlices: [] as PieSlice[],
      excludedCount,
      isLeveragedView,
      pieBackground: '',
    };
  }

  const normalizedSlices = pieSlices.map((slice) => ({
    ...slice,
    normalizedPercent:
      hasDenominator && !isLeveragedView ? (slice.accountPercent ?? 0) : slice.value / totalForPie,
  }));

  return {
    effectivePositionPercent,
    totalPotentialIPercent,
    totalPotentialIIPercent,
    usedPercent,
    unusedPercent,
    pieSlices: normalizedSlices,
    excludedCount,
    isLeveragedView,
    pieBackground: buildPieBackground(normalizedSlices),
  };
}

function PositionSummaryPanel({
  positions,
  percentageDenominator,
}: {
  positions: Position[];
  percentageDenominator: number | null;
}) {
  const summary = buildPositionSummary(positions, percentageDenominator);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <div className="bg-white shadow rounded-lg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500">Effective Exposure %</div>
        <div className="mt-2 text-2xl font-semibold text-gray-900">
          {summary.effectivePositionPercent != null ? formatPercent(summary.effectivePositionPercent) : '-'}
        </div>
        <div className="mt-1 text-sm text-gray-500">
          Leverage-adjusted positive effective exposure / selected total value
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500">Potential I Exposure %</div>
        <div className="mt-2 text-2xl font-semibold text-gray-900">
          {summary.totalPotentialIPercent != null ? formatPercent(summary.totalPotentialIPercent) : '-'}
        </div>
        <div className="mt-1 text-sm text-gray-500">
          In-band buys minus safe called-away sells
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500">Potential II Exposure %</div>
        <div className="mt-2 text-2xl font-semibold text-gray-900">
          {summary.totalPotentialIIPercent != null ? formatPercent(summary.totalPotentialIIPercent) : '-'}
        </div>
        <div className="mt-1 text-sm text-gray-500">
          Stock + all potential buys
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-4 lg:col-span-2">
        <div className="text-sm font-medium text-gray-900">Exposure Allocation Pie</div>
        {summary.pieSlices.length > 0 ? (
          <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-start">
            <div className="relative h-52 w-52 flex-shrink-0 self-center md:self-start">
              <div
                className="h-full w-full rounded-full"
                style={{ background: summary.pieBackground }}
                aria-hidden
              />
              <div className="absolute inset-7 flex items-center justify-center rounded-full bg-white text-center">
                <div>
                  <div className="text-xs uppercase tracking-wider text-gray-500">Used</div>
                  <div className="text-lg font-semibold text-gray-900">
                    {summary.usedPercent != null ? formatPercent(summary.usedPercent) : '-'}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
                {summary.pieSlices.map((slice) => (
                  <div key={slice.label} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0 flex items-center gap-2">
                      <span
                        className="h-3 w-3 flex-shrink-0 rounded-sm"
                        style={{ backgroundColor: slice.color }}
                        aria-hidden
                      />
                      <span className="truncate text-gray-700">{slice.label}</span>
                    </div>
                    <div className="flex-shrink-0 text-right text-gray-900">
                      {slice.accountPercent != null ? formatPercent(slice.accountPercent) : '-'}
                    </div>
                  </div>
                ))}
                {summary.unusedPercent > 1e-8 ? (
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0 flex items-center gap-2">
                      <span
                        className="h-3 w-3 flex-shrink-0 rounded-sm"
                        style={{ backgroundColor: '#d1d5db' }}
                        aria-hidden
                      />
                      <span className="truncate text-gray-700">Unused Cash / Other</span>
                    </div>
                    <div className="flex-shrink-0 text-right text-gray-900">
                      {formatPercent(summary.unusedPercent)}
                    </div>
                  </div>
                ) : null}
              </div>
              {summary.excludedCount > 0 ? (
                <div className="mt-3 text-xs text-gray-500">
                  Excluded {summary.excludedCount} non-positive effective position
                  {summary.excludedCount > 1 ? 's' : ''} from pie.
                </div>
              ) : null}
              {summary.isLeveragedView ? (
                <div className="mt-1 text-xs text-amber-700">
                  Total long exposure is above 100%; pie is normalized by long exposure.
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-3 text-sm text-gray-500">No positive effective positions available for pie chart.</div>
        )}
      </div>
    </div>
  );
}

export function Positions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCategory, setSelectedCategory] = useState<AccountCategoryFilter>('all');
  const [showClosedLots, setShowClosedLots] = useState(false);

  const selectedAccountParam = searchParams.get('account');
  const parsedSelectedAccount =
    selectedAccountParam != null && /^\d+$/.test(selectedAccountParam)
      ? Number(selectedAccountParam)
      : null;
  const selectedAccount =
    parsedSelectedAccount != null && Number.isInteger(parsedSelectedAccount) && parsedSelectedAccount > 0
      ? parsedSelectedAccount
      : null;

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const categorizedAccounts = useMemo(() => {
    const stockIds = new Set<number>();
    const indexIds = new Set<number>();

    for (const account of accounts ?? []) {
      const category = getAccountCategory(account);
      if (category === 'index') {
        indexIds.add(account.id);
      } else {
        stockIds.add(account.id);
      }
    }

    return { stockIds, indexIds };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const allAccounts = accounts ?? [];
    if (selectedCategory === 'stock') {
      return allAccounts.filter((account) => categorizedAccounts.stockIds.has(account.id));
    }
    if (selectedCategory === 'index') {
      return allAccounts.filter((account) => categorizedAccounts.indexIds.has(account.id));
    }
    return allAccounts;
  }, [accounts, categorizedAccounts, selectedCategory]);

  useEffect(() => {
    if (selectedAccountParam == null) {
      return;
    }

    if (selectedAccount == null) {
      setSearchParams((currentParams) => {
        const nextParams = new URLSearchParams(currentParams);
        nextParams.delete('account');
        return nextParams;
      }, { replace: true });
      return;
    }

    if (accounts == null) {
      return;
    }

    if (!accounts?.some((account) => account.id === selectedAccount)) {
      setSearchParams((currentParams) => {
        const nextParams = new URLSearchParams(currentParams);
        nextParams.delete('account');
        return nextParams;
      }, { replace: true });
    }
  }, [accounts, selectedAccount, selectedAccountParam, setSearchParams]);

  const { data: positions, isLoading } = useQuery({
    queryKey: ['positions', selectedAccount, { includeClosed: showClosedLots }],
    queryFn: () =>
      selectedAccount
        ? positionsApi.byAccount(selectedAccount, showClosedLots)
        : positionsApi.list(showClosedLots),
  });

  const { data: accountPerformance } = useQuery({
    queryKey: ['accounts-performance'],
    queryFn: analyticsApi.accountsPerformance,
  });

  const { data: tickerPnlData } = useQuery({
    queryKey: ['ticker-pnl', selectedAccount],
    queryFn: () =>
      selectedAccount ? analyticsApi.tickerPnl(selectedAccount) : analyticsApi.tickerPnl(),
  });

  const positionsForSelectedCategory = useMemo(() => {
    const allPositions = positions ?? [];
    if (selectedAccount) {
      return allPositions;
    }
    if (selectedCategory === 'stock') {
      return allPositions.filter((pos) => categorizedAccounts.stockIds.has(pos.account_id));
    }
    if (selectedCategory === 'index') {
      return allPositions.filter((pos) => categorizedAccounts.indexIds.has(pos.account_id));
    }
    return allPositions;
  }, [positions, selectedAccount, selectedCategory, categorizedAccounts]);

  const percentageDenominator = useMemo(() => {
    if (!accountPerformance || accountPerformance.length === 0) {
      return null;
    }

    if (selectedAccount) {
      const row = accountPerformance.find((entry) => entry.account_id === selectedAccount);
      return row?.total_value ?? null;
    }

    if (selectedCategory === 'stock') {
      return accountPerformance
        .filter((row) => categorizedAccounts.stockIds.has(row.account_id))
        .reduce((sum, row) => sum + row.total_value, 0);
    }

    if (selectedCategory === 'index') {
      return accountPerformance
        .filter((row) => categorizedAccounts.indexIds.has(row.account_id))
        .reduce((sum, row) => sum + row.total_value, 0);
    }

    return accountPerformance.reduce((sum, row) => sum + row.total_value, 0);
  }, [accountPerformance, selectedAccount, selectedCategory, categorizedAccounts]);

  const buildRealizedPnlMap = (accountIds?: Set<number>) => {
    const map = new Map<number, { stock: number; option: number }>();
    for (const entry of tickerPnlData ?? []) {
      if (accountIds && !accountIds.has(entry.account_id)) continue;
      const prev = map.get(entry.ticker_id) ?? { stock: 0, option: 0 };
      map.set(entry.ticker_id, {
        stock: prev.stock + entry.realized_stock_pnl,
        option: prev.option + entry.realized_option_pnl,
      });
    }
    return map;
  };

  const realizedPnlByTicker = useMemo(() => {
    if (selectedAccount) return buildRealizedPnlMap();
    if (selectedCategory === 'stock') return buildRealizedPnlMap(categorizedAccounts.stockIds);
    if (selectedCategory === 'index') return buildRealizedPnlMap(categorizedAccounts.indexIds);
    return buildRealizedPnlMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickerPnlData, selectedAccount, selectedCategory, categorizedAccounts]);

  const perAccountData = useMemo(() => {
    const allPositions = positions ?? [];
    const performanceRows = accountPerformance ?? [];
    return filteredAccounts
      .map((account) => {
        const acctPositions = allPositions.filter((p) => p.account_id === account.id);
        const perf = performanceRows.find((r) => r.account_id === account.id);
        const denominator = perf?.total_value ?? null;
        const pnlMap = buildRealizedPnlMap(new Set([account.id]));
        return { account, positions: acctPositions, denominator, pnlMap };
      })
      .filter((entry) => entry.positions.length > 0)
      .sort((a, b) => (b.denominator ?? 0) - (a.denominator ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, accountPerformance, filteredAccounts, tickerPnlData]);

  const showPerAccount = !selectedAccount;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Positions</h1>
        <div className="flex items-center gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              checked={showClosedLots}
              onChange={(e) => setShowClosedLots(e.target.checked)}
            />
            Show closed lots
          </label>
          <select
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={selectedCategory}
            onChange={(e) => {
              const category = e.target.value as AccountCategoryFilter;
              setSelectedCategory(category);
              if (!selectedAccount) {
                return;
              }

              if (category === 'all') {
                return;
              }

              if (
                (category === 'stock' && categorizedAccounts.stockIds.has(selectedAccount)) ||
                (category === 'index' && categorizedAccounts.indexIds.has(selectedAccount))
              ) {
                return;
              }

              setSearchParams((currentParams) => {
                const nextParams = new URLSearchParams(currentParams);
                nextParams.delete('account');
                return nextParams;
              });
            }}
          >
            <option value="all">All Categories</option>
            <option value="stock">Category 1: Free Stock Trading</option>
            <option value="index">Category 2: Index Only</option>
          </select>
          <select
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={selectedAccount || ''}
            onChange={(e) => {
              const nextValue = e.target.value;
              setSearchParams((currentParams) => {
                const nextParams = new URLSearchParams(currentParams);
                if (nextValue) {
                  nextParams.set('account', nextValue);
                } else {
                  nextParams.delete('account');
                }
                return nextParams;
              });
            }}
          >
            <option value="">All Accounts</option>
            {filteredAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showPerAccount ? (
        <div className="space-y-6">
          {perAccountData.map(({ account, positions: acctPositions, denominator, pnlMap }) => (
            <div key={account.id} className="space-y-4">
              <PositionSummaryPanel
                positions={acctPositions}
                percentageDenominator={denominator}
              />
              <div className="bg-white shadow rounded-lg">
                <div className="px-4 py-3 border-b border-gray-200">
                  <div className="text-sm font-medium text-gray-900">
                    {account.code}{account.name ? ` — ${account.name}` : ''}
                  </div>
                </div>
                <AggregatedPositionTable
                  positions={acctPositions}
                  mode="positions"
                  percentageDenominator={denominator}
                  realizedPnlByTicker={pnlMap}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-3 border-b border-gray-200 text-sm font-medium text-gray-900">
            Positions (Merged by Ticker)
          </div>
          {isLoading ? (
            <div className="p-4 text-gray-500">Loading...</div>
          ) : positionsForSelectedCategory.length > 0 ? (
            <AggregatedPositionTable
              positions={positionsForSelectedCategory}
              mode="positions"
              percentageDenominator={percentageDenominator}
              realizedPnlByTicker={realizedPnlByTicker}
            />
          ) : (
            <div className="p-4 text-gray-500">No positions found</div>
          )}
        </div>
      )}

      {!showPerAccount ? (
        <PositionSummaryPanel
          positions={positionsForSelectedCategory}
          percentageDenominator={percentageDenominator}
        />
      ) : null}
    </div>
  );
}
