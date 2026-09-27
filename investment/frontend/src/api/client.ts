import { uploadWorkbook } from './uploads';
import { api, isCloudApi } from './http';
import type {
  Account,
  Ticker,
  PaginatedTransactions,
  TransactionWithDetails,
  Position,
  PortfolioSummary,
  YieldMetrics,
  AccountPerformance,
  TickerRealizedPnl,
  ApiUsageSummary,
  CacheClearRequest,
  CacheClearResponse,
  CacheCoverage,
  CachePriceTrend,
  PrefetchRequest,
  PrefetchResponse,
  ImportResult,
  SnapTradeRegisterResult,
  SnapTradeAccount,
  SnapTradeImportResult,
  TransactionFilter,
  CreateTransactionRequest,
  UpdateTransactionRequest,
  RollOptionRequest,
  RollOptionResponse,
  CloseOptionRequest,
  CloseOptionResponse,
  ExpireOptionRequest,
  ExpireOptionResponse,
  AssignOptionRequest,
  AssignOptionResponse,
} from './types';
import { ensureWasm } from './wasm';

import { readGeneration, getDataset, resync } from './rxdb';
import { isCashEquivalentSecuritySymbol } from '../utils/cashEquivalents';

// Writes are authenticated and carry durable retry IDs; reads pin one verified generation.
const afterWrite = <T>(result: Promise<T>): Promise<T> => result;
export const refreshFromBackend = resync;
export const accountsApi = {
  list: async (): Promise<Account[]> => (await readGeneration()).tables.accounts.map((row) => ({ ...row })),
  get: async (id: number): Promise<Account> => { const row = (await readGeneration()).tables.accounts.find((r) => r.id === id); if (!row) throw new Error(`account ${id} not found`); return { ...row }; },
  create: (data: { code: string; name?: string; account_type?: string }): Promise<Account> => api.post<Account>('/accounts', data).then((r) => r.data),
};
export const tickersApi = { list: async (): Promise<Ticker[]> => (await readGeneration()).tables.tickers.map((r) => ({ ...r })) };
export const transactionsApi = {
  list: async (filter?: TransactionFilter): Promise<PaginatedTransactions> => {
    const { tables } = await readGeneration();
    const symbols = new Map(tables.tickers.map((r) => [r.id, r.symbol]));
    const accounts = new Map(tables.accounts.map((r) => [r.id, r.code]));
    const rows = tables.transactions.filter((r) =>
      !isCashEquivalentSecuritySymbol(symbols.get(r.ticker_id))
      && (filter?.account_id == null || r.account_id === filter.account_id)
      && (filter?.ticker_id == null || r.ticker_id === filter.ticker_id)
      && (!filter?.transaction_type || r.transaction_type === filter.transaction_type)
      && (!filter?.status || r.status === filter.status)
      && (!filter?.start_date || r.date >= filter.start_date)
      && (!filter?.end_date || r.date <= filter.end_date)
      && (!filter?.symbol || symbols.get(r.ticker_id)?.toLowerCase().includes(filter.symbol.toLowerCase())),
    ).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const limit = Math.min(500, Math.max(1, filter?.limit ?? 100));
    const offset = Math.max(0, filter?.offset ?? 0);
    return { total: rows.length, limit, offset, items: rows.slice(offset, offset + limit).map((r) => ({ ...r, account_code: accounts.get(r.account_id)!, ticker_symbol: symbols.get(r.ticker_id)! })) };
  },
  get: async (id: number): Promise<TransactionWithDetails> => {
    const { tables } = await readGeneration();
    const row = tables.transactions.find((r) => r.id === id);
    if (!row) throw new Error(`transaction ${id} not found`);
    const symbol = tables.tickers.find((r) => r.id === row.ticker_id)!.symbol;
    if (isCashEquivalentSecuritySymbol(symbol)) throw new Error(`transaction ${id} is a cash-equivalent security row`);
    return { ...row, account_code: tables.accounts.find((r) => r.id === row.account_id)!.code, ticker_symbol: symbol };
  },
  create: (data: CreateTransactionRequest): Promise<unknown> =>
    afterWrite(api.post('/transactions', data).then((r) => r.data)),
  rollOption: (data: RollOptionRequest): Promise<RollOptionResponse> =>
    afterWrite(api.post<RollOptionResponse>('/transactions/roll-option', data).then((r) => r.data)),
  closeOption: (data: CloseOptionRequest): Promise<CloseOptionResponse> =>
    afterWrite(api.post<CloseOptionResponse>('/transactions/close-option', data).then((r) => r.data)),
  expireOption: (data: ExpireOptionRequest): Promise<ExpireOptionResponse> =>
    afterWrite(api.post<ExpireOptionResponse>('/transactions/expire-option', data).then((r) => r.data)),
  assignOption: (data: AssignOptionRequest): Promise<AssignOptionResponse> =>
    afterWrite(api.post<AssignOptionResponse>('/transactions/assign-option', data).then((r) => r.data)),
  update: (id: number, data: UpdateTransactionRequest): Promise<unknown> =>
    afterWrite(api.put(`/transactions/${id}`, data).then((r) => r.data)),
  delete: (id: number): Promise<unknown> =>
    afterWrite(api.delete(`/transactions/${id}`).then((r) => r.data)),
};

export const positionsApi = {
  list: async (includeClosed = false): Promise<Position[]> => {
    const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]);
    return wasm.positions(d.txns, d.accounts, d.tickers, d.prices, undefined, includeClosed) as Position[];
  },
  byAccount: async (accountId: number, includeClosed = false): Promise<Position[]> => {
    const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]);
    return wasm.positions(d.txns, d.accounts, d.tickers, d.prices, accountId, includeClosed) as Position[];
  },
};

export const analyticsApi = {
  summary: async (): Promise<PortfolioSummary> => { const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]); return wasm.portfolio_summary(d.txns, d.accounts, d.tickers) as PortfolioSummary; },
  yield: async (): Promise<YieldMetrics> => { const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]); return { annual_yield_rate: wasm.portfolio_yield(d.txns, d.accounts, d.tickers, d.prices, d.today) as number }; },
  accountsPerformance: async (): Promise<AccountPerformance[]> => {
    const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]);
    return wasm.account_performance_snapshot(d.txns, d.accounts, d.tickers, d.prices, d.brokers, d.today, d.historical, d.snapshots) as AccountPerformance[];
  },
  tickerPnl: async (accountId?: number): Promise<TickerRealizedPnl[]> => {
    const [d, wasm] = await Promise.all([getDataset(), ensureWasm()]);
    return wasm.realized_pnl(d.txns, d.accounts, d.tickers, accountId ?? undefined) as TickerRealizedPnl[];
  },
};

export const adminApi = {
  usageSummary: () => api.get<ApiUsageSummary>('/admin/api-usage').then((res) => res.data),
  cacheCoverage: (symbol: string, days = 365) =>
    api.get<CacheCoverage>('/admin/cache-coverage', { params: { symbol, days } }).then((res) => res.data),
  cachePriceTrend: (symbol: string, days = 365) =>
    api.get<CachePriceTrend>('/admin/cache-price-trend', { params: { symbol, days } }).then((res) => res.data),
  clearCache: (data: CacheClearRequest) =>
    api.post<CacheClearResponse>('/admin/api-usage/cache/clear', data).then((res) => res.data),
  prefetchCache: (data: PrefetchRequest) =>
    api.post<PrefetchResponse>('/admin/api-usage/cache/prefetch', data).then((res) => res.data),
};

export const importApi = {
  excel: (file: File, progress?: (percent: number) => void) => {
    if (isCloudApi) return uploadWorkbook(file, progress);
    const formData = new FormData();
    formData.append('file', file);
    return api
      .post<ImportResult>('/import/excel', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((res) => res.data);
  },
};

export const snaptradeApi = {
  status: () =>
    api.get<{ last_synced_at: string | null }>('/snaptrade/status').then((res) => res.data),
  register: () => api.post<SnapTradeRegisterResult>('/snaptrade/register').then((res) => res.data),
  connect: (broker?: string) =>
    api.get<{ redirect_uri: string }>('/snaptrade/connect', { params: broker ? { broker } : {} }).then((res) => res.data),
  accounts: () => api.get<{ accounts: SnapTradeAccount[] }>('/snaptrade/accounts').then((res) => res.data.accounts),
  link: (snaptradeAccountId: string, accountId: number) =>
    api
      .post(`/snaptrade/accounts/${encodeURIComponent(snaptradeAccountId)}/link`, { account_id: accountId })
      .then((res) => res.data),
  import: (opts?: { apply?: boolean; start_date?: string }) =>
    api.post<SnapTradeImportResult>('/import/snaptrade', null, { params: opts ?? {} }).then((res) => res.data),
};
