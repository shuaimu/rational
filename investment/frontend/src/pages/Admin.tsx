import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../api/client';
import type { CacheClearRequest } from '../api/types';

function parseSymbols(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'fmp':
      return 'Financial Modeling Prep';
    case 'twelvedata':
      return 'Twelve Data';
    case 'yfinance':
      return 'Yahoo Finance';
    default:
      return provider;
  }
}

export function Admin() {
  const queryClient = useQueryClient();
  const [symbolsInput, setSymbolsInput] = useState('AAPL,MSFT,GOOG');
  const [prefetchDays, setPrefetchDays] = useState(30);
  const [clearSymbol, setClearSymbol] = useState('');
  const [clearOlderThanDays, setClearOlderThanDays] = useState(90);
  const [coverageSymbol, setCoverageSymbol] = useState('');
  const [coverageDays, setCoverageDays] = useState(365);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, isLoading, error: summaryError, refetch: reloadSummary } = useQuery({
    queryKey: ['admin-api-usage'],
    queryFn: adminApi.usageSummary,
  });
  const selectedCoverageSymbol =
    coverageSymbol || (data?.cached_symbols?.length ? data.cached_symbols[0] : '');

  const { data: coverage, isLoading: coverageLoading } = useQuery({
    queryKey: ['admin-cache-coverage', selectedCoverageSymbol, coverageDays],
    queryFn: () => adminApi.cacheCoverage(selectedCoverageSymbol, coverageDays),
    enabled: selectedCoverageSymbol.length > 0,
  });
  const {
    data: priceTrend,
    isLoading: priceTrendLoading,
    isError: priceTrendIsError,
    error: priceTrendError,
  } = useQuery({
    queryKey: ['admin-cache-price-trend', selectedCoverageSymbol, coverageDays],
    queryFn: () => adminApi.cachePriceTrend(selectedCoverageSymbol, coverageDays),
    enabled: selectedCoverageSymbol.length > 0,
  });

  const clearCacheMutation = useMutation({
    mutationFn: (payload: CacheClearRequest) => adminApi.clearCache(payload),
    onSuccess: (result) => {
      setErrorMessage(null);
      setMessage(`Cleared ${result.deleted_rows} cache rows (${result.scope}).`);
      queryClient.invalidateQueries({ queryKey: ['admin-api-usage'] });
    },
    onError: (error: Error) => {
      setMessage(null);
      setErrorMessage(error.message || 'Failed to clear cache.');
    },
  });

  const prefetchMutation = useMutation({
    mutationFn: adminApi.prefetchCache,
    onSuccess: (result) => {
      setErrorMessage(null);
      setMessage(
        `Prefetched ${result.cached_symbols}/${result.requested_symbols} symbols (${result.bars_cached} bars, ${result.start_date} to ${result.end_date}).`,
      );
      queryClient.invalidateQueries({ queryKey: ['admin-api-usage'] });
    },
    onError: (error: Error) => {
      setMessage(null);
      setErrorMessage(error.message || 'Failed to prefetch cache.');
    },
  });

  const formatDate = (value: string | null) => value ?? '-';
  const formatDateTime = (value: string | null) => value ?? '-';
  const formatNum = (value: number) => new Intl.NumberFormat('en-US').format(value);
  const formatPrice = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

  const coverageSegments = useMemo(() => {
    if (!coverage) {
      return [] as boolean[];
    }

    const cachedSet = new Set(coverage.cached_dates);
    return coverage.trading_dates.map((date) => cachedSet.has(date));
  }, [coverage]);

  const trendChart = useMemo(() => {
    if (!priceTrend || priceTrend.points.length < 2) {
      return null;
    }

    const width = 720;
    const height = 220;
    const marginLeft = 56;
    const marginRight = 8;
    const marginTop = 12;
    const marginBottom = 14;
    const plotWidth = width - marginLeft - marginRight;
    const plotHeight = height - marginTop - marginBottom;

    const minPrice =
      priceTrend.min_price ??
      priceTrend.points.reduce((min, point) => Math.min(min, point.price), priceTrend.points[0].price);
    const maxPrice =
      priceTrend.max_price ??
      priceTrend.points.reduce((max, point) => Math.max(max, point.price), priceTrend.points[0].price);
    const priceRange = Math.max(maxPrice - minPrice, Number.EPSILON);

    const points = priceTrend.points.map((point, index) => {
      const x = marginLeft + (index / (priceTrend.points.length - 1)) * plotWidth;
      const y = marginTop + (1 - (point.price - minPrice) / priceRange) * plotHeight;
      return { x, y };
    });

    const tickCount = 5;
    const yTicks = Array.from({ length: tickCount }, (_, index) => {
      const ratio = index / (tickCount - 1);
      const value = maxPrice - ratio * (maxPrice - minPrice);
      const y = marginTop + ratio * plotHeight;
      return { value, y };
    });

    const linePath = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(height - marginBottom).toFixed(2)} L ${points[0].x.toFixed(2)} ${(height - marginBottom).toFixed(2)} Z`;

    return {
      width,
      height,
      marginLeft,
      marginRight,
      marginTop,
      marginBottom,
      linePath,
      areaPath,
      yTicks,
      minPrice,
      maxPrice,
      firstDate: priceTrend.points[0].date,
      lastDate: priceTrend.points[priceTrend.points.length - 1].date,
    };
  }, [priceTrend]);

  const handlePrefetch = () => {
    const symbols = parseSymbols(symbolsInput);
    if (symbols.length === 0) {
      setMessage(null);
      setErrorMessage('Enter at least one symbol.');
      return;
    }

    prefetchMutation.mutate({
      symbols,
      days: Math.max(1, Math.min(3650, prefetchDays)),
    });
  };

  const handleClear = (payload: CacheClearRequest, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) {
      return;
    }
    clearCacheMutation.mutate(payload);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Admin API Usage</h1>
        {data?.as_of && <p className="text-sm text-gray-500">Cache summary captured {new Date(data.as_of).toLocaleString()}</p>}
      </div>

      {message ? <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div> : null}
      {errorMessage ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{errorMessage}</div> : null}

      {summaryError && !data ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
          <p>{summaryError.message || 'The cache summary could not be loaded.'}</p>
          <button className="mt-2 underline" onClick={() => void reloadSummary()}>Retry</button>
        </div>
      ) : isLoading || !data ? (
        <div className="text-gray-500">Loading...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Cache Rows</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{formatNum(data.total_records)}</div>
            </div>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Unique Symbols</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{formatNum(data.unique_symbols)}</div>
            </div>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Rows Today</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900">{formatNum(data.records_today)}</div>
            </div>
            <div className="rounded-lg bg-white p-5 shadow">
              <div className="text-sm text-gray-500">Date Range</div>
              <div className="mt-1 text-sm font-medium text-gray-900">
                {formatDate(data.earliest_price_date)} to {formatDate(data.latest_price_date)}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white p-5 shadow">
            <h2 className="text-lg font-semibold text-gray-900">Providers</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between rounded border border-gray-200 p-3">
                <span className="text-sm font-medium text-gray-700">Financial Modeling Prep</span>
                <span
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    data.providers.fmp_enabled
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {data.providers.fmp_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded border border-gray-200 p-3">
                <span className="text-sm font-medium text-gray-700">Twelve Data</span>
                <span
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    data.providers.twelve_data_enabled
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {data.providers.twelve_data_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded border border-gray-200 p-3">
                <span className="text-sm font-medium text-gray-700">Yahoo Finance</span>
                <span
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    data.providers.yahoo_finance_enabled
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {data.providers.yahoo_finance_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white p-5 shadow">
            <h2 className="text-lg font-semibold text-gray-900">Provider Request Metrics (Today)</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {data.provider_metrics.map((metric) => (
                <div key={metric.provider} className="rounded border border-gray-200 p-4">
                  <div className="text-sm font-medium text-gray-700">{providerDisplayName(metric.provider)}</div>
                  <div className="mt-3 space-y-1 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">Requests Used</span>
                      <span className="font-semibold text-gray-900">{formatNum(metric.requests_today)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">Success Rate</span>
                      <span className="font-semibold text-emerald-700">{metric.success_rate.toFixed(2)}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">Failed Rate</span>
                      <span className="font-semibold text-red-700">{metric.failed_rate.toFixed(2)}%</span>
                    </div>
                    <div className="pt-1 text-xs text-gray-500">
                      Success: {formatNum(metric.success_today)} | Failed: {formatNum(metric.failed_today)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-white p-5 shadow">
            <h2 className="text-lg font-semibold text-gray-900">Cache Coverage Timeline</h2>
            {data.cached_symbols.length === 0 ? (
              <div className="mt-3 text-sm text-gray-500">No cached symbols yet.</div>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <label className="text-sm text-gray-700">
                    Symbol
                    <select
                      className="ml-2 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={selectedCoverageSymbol}
                      onChange={(e) => setCoverageSymbol(e.target.value)}
                    >
                      {data.cached_symbols.map((symbol) => (
                        <option key={symbol} value={symbol}>
                          {symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-gray-700">
                    Days
                    <select
                      className="ml-2 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={coverageDays}
                      onChange={(e) => setCoverageDays(Number(e.target.value))}
                    >
                      {[30, 90, 180, 365, 730].map((days) => (
                        <option key={days} value={days}>
                          {days}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {coverageLoading || !coverage ? (
                  <div className="mt-4 text-sm text-gray-500">Loading timeline...</div>
                ) : (
                  <>
                    <div className="mt-4 flex items-center justify-between text-sm">
                      <span className="text-gray-600">
                        {coverage.start_date} to {coverage.end_date}
                      </span>
                      <span className="font-medium text-gray-900">
                        {formatNum(coverage.cached_days)} / {formatNum(coverage.total_days)} days cached (
                        {coverage.coverage_rate.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="mt-3 h-5 w-full overflow-hidden rounded bg-gray-200">
                      <div className="flex h-full w-full">
                        {coverageSegments.map((hasCache, index) => (
                          <div
                            key={`${coverage.symbol}-${index}`}
                            className={hasCache ? 'bg-emerald-500' : 'bg-gray-300'}
                            style={{ flex: 1 }}
                            title={hasCache ? 'Cached' : 'Missing'}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-xs text-gray-600">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-3 rounded bg-emerald-500" /> Cached
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-3 rounded bg-gray-300" /> Missing
                      </span>
                    </div>

                    <div className="mt-6 border-t border-gray-200 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-gray-900">Cached Price Trend</h3>
                        <div className="text-xs text-gray-600">
                          {priceTrend?.latest_price != null ? (
                            <>
                              Latest: <span className="font-medium text-gray-900">{formatPrice(priceTrend.latest_price)}</span>{' '}
                              ({priceTrend.change_pct != null ? formatPercent(priceTrend.change_pct) : '-'})
                            </>
                          ) : (
                            <>Latest: -</>
                          )}
                        </div>
                      </div>

                      {priceTrendLoading ? (
                        <div className="mt-3 text-sm text-gray-500">Loading price trend...</div>
                      ) : priceTrendIsError ? (
                        <div className="mt-3 text-sm text-red-600">
                          Failed to load price trend: {(priceTrendError as Error).message}
                        </div>
                      ) : trendChart ? (
                        <>
                          <div className="mt-2 text-xs text-gray-500">
                            Trading days only, based on cached rows ({formatNum(priceTrend?.points.length ?? 0)} points).
                          </div>
                          <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-2">
                            <div className="w-full aspect-[36/11]">
                              <svg
                                className="block h-full w-full"
                                viewBox={`0 0 ${trendChart.width} ${trendChart.height}`}
                                role="img"
                                aria-label={`${selectedCoverageSymbol} cached price trend`}
                              >
                                <defs>
                                  <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.22" />
                                    <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
                                  </linearGradient>
                                </defs>
                                <rect x={0} y={0} width={trendChart.width} height={trendChart.height} fill="#f8fafc" />
                                {trendChart.yTicks.map((tick) => (
                                  <g key={tick.y.toFixed(2)}>
                                    <line
                                      x1={trendChart.marginLeft}
                                      x2={trendChart.width - trendChart.marginRight}
                                      y1={tick.y}
                                      y2={tick.y}
                                      stroke="#e5e7eb"
                                      strokeWidth={1}
                                    />
                                    <text
                                      x={trendChart.marginLeft - 8}
                                      y={tick.y + 4}
                                      fontSize={11}
                                      textAnchor="end"
                                      fill="#6b7280"
                                    >
                                      {tick.value.toFixed(2)}
                                    </text>
                                  </g>
                                ))}
                                <line
                                  x1={trendChart.marginLeft}
                                  x2={trendChart.marginLeft}
                                  y1={trendChart.marginTop}
                                  y2={trendChart.height - trendChart.marginBottom}
                                  stroke="#d1d5db"
                                  strokeWidth={1}
                                />
                                <path d={trendChart.areaPath} fill="url(#trend-fill)" />
                                <path d={trendChart.linePath} fill="none" stroke="#059669" strokeWidth={2.5} />
                              </svg>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
                            <span>{trendChart.firstDate}</span>
                            <span>
                              Range: {formatPrice(trendChart.minPrice)} - {formatPrice(trendChart.maxPrice)}
                            </span>
                            <span>{trendChart.lastDate}</span>
                          </div>
                        </>
                      ) : (
                        <div className="mt-3 text-sm text-gray-500">
                          Not enough cached trading-day points to draw a trend line.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="rounded-lg bg-white p-5 shadow">
            <h2 className="text-lg font-semibold text-gray-900">Manage Cache</h2>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded border border-gray-200 p-4">
                <div className="text-sm font-medium text-gray-700">Prefetch prices</div>
                <input
                  type="text"
                  className="w-full rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  placeholder="AAPL, MSFT, GOOG"
                  value={symbolsInput}
                  onChange={(e) => setSymbolsInput(e.target.value)}
                />
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-700">
                    Days
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      className="ml-2 w-24 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={prefetchDays}
                      onChange={(e) => setPrefetchDays(Number(e.target.value) || 1)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handlePrefetch}
                    disabled={prefetchMutation.isPending}
                    className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {prefetchMutation.isPending ? 'Prefetching...' : 'Prefetch'}
                  </button>
                </div>
              </div>

              <div className="space-y-3 rounded border border-gray-200 p-4">
                <div className="text-sm font-medium text-gray-700">Clear cache</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleClear({ scope: 'today' })}
                    disabled={clearCacheMutation.isPending}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                  >
                    Clear today
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleClear(
                        { scope: 'all' },
                        'This will delete all cached prices. Continue?',
                      )
                    }
                    disabled={clearCacheMutation.isPending}
                    className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50"
                  >
                    Clear all
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    className="w-28 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={clearOlderThanDays}
                    onChange={(e) => setClearOlderThanDays(Number(e.target.value) || 1)}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleClear({
                        scope: 'older_than_days',
                        days: Math.max(1, clearOlderThanDays),
                      })
                    }
                    disabled={clearCacheMutation.isPending}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                  >
                    Clear older than N days
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Symbol (e.g. AAPL)"
                    className="w-52 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={clearSymbol}
                    onChange={(e) => setClearSymbol(e.target.value.toUpperCase())}
                  />
                  <button
                    type="button"
                    onClick={() => handleClear({ scope: 'symbol', symbol: clearSymbol })}
                    disabled={clearCacheMutation.isPending}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                  >
                    Clear symbol
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div className="rounded-lg bg-white shadow">
              <div className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
                Usage by Source
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Source
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Rows
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Symbols
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Last Fetch
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white text-sm">
                    {data.by_source.map((row) => (
                      <tr key={row.source}>
                        <td className="px-4 py-2 text-gray-900">{row.source}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatNum(row.record_count)}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatNum(row.symbol_count)}</td>
                        <td className="px-4 py-2 text-right text-gray-600">{formatDateTime(row.last_fetched_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-lg bg-white shadow">
              <div className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
                Daily Cache Activity (30d)
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Date
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Rows
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Symbols
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white text-sm">
                    {data.daily.map((row) => (
                      <tr key={row.price_date}>
                        <td className="px-4 py-2 text-gray-900">{row.price_date}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatNum(row.fetch_count)}</td>
                        <td className="px-4 py-2 text-right text-gray-900">{formatNum(row.symbol_count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white shadow">
            <div className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
              Latest Fetch Per Symbol
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Symbol
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Price Date
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Price
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Source
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Fetched At
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white text-sm">
                  {data.recent_fetches.map((row, index) => (
                    <tr key={`${row.symbol}-${row.price_date}-${row.fetched_at}-${index}`}>
                      <td className="px-4 py-2 text-gray-900">{row.symbol}</td>
                      <td className="px-4 py-2 text-gray-900">{row.price_date}</td>
                      <td className="px-4 py-2 text-right text-gray-900">{row.price.toFixed(4)}</td>
                      <td className="px-4 py-2 text-gray-600">{row.source}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{formatDateTime(row.fetched_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
