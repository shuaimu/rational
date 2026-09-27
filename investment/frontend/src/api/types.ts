export interface Account {
  id: number;
  code: string;
  name: string | null;
  account_type: string | null;
}

export interface Ticker {
  id: number;
  symbol: string;
  name: string | null;
}

export interface Transaction {
  id: number;
  account_id: number;
  ticker_id: number;
  transaction_type: string;
  quantity: number;
  price: number;
  cost: number;
  fees: number | null;
  date: string;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_code: string | null;
  status: string | null;
}

export interface CreateTransactionRequest {
  account_id: number;
  ticker_id?: number;
  ticker_symbol?: string;
  transaction_type: string;
  quantity: number;
  price: number;
  cost: number;
  fees?: number | null;
  date: string;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date?: string | null;
  option_code?: string | null;
  status?: string | null;
}

export interface UpdateTransactionRequest {
  account_id?: number;
  ticker_id?: number;
  ticker_symbol?: string;
  transaction_type?: string;
  quantity?: number;
  price?: number;
  cost?: number;
  fees?: number | null;
  date?: string;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date?: string | null;
  option_code?: string | null;
  status?: string | null;
}

export interface RollOptionRequest {
  account_id: number;
  ticker_id: number;
  old_option_code: string;
  old_opened_date: string;
  old_option_type?: string | null;
  old_strike_price?: number | null;
  old_expiration_date?: string | null;
  quantity: number;
  close_fees?: number | null;
  roll_date: string;
  new_option_type: string;
  new_strike_price: number;
  new_expiration_date: string;
  new_option_code: string;
  roll_cost: number;
  open_fees?: number | null;
}

export interface RollOptionResponse {
  closed_updated: number;
  extended_transaction_id: number;
  sell_extended_transaction_id: number;
}

export interface CloseOptionRequest {
  account_id: number;
  ticker_id: number;
  option_code: string;
  opened_date: string;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date?: string | null;
  quantity: number;
  original_quantity: number;
  cost: number;
  fees?: number | null;
  close_date: string;
}

export interface CloseOptionResponse {
  closed_updated: number;
  close_transaction_id: number;
  close_transaction_type: string;
}

export interface ExpireOptionRequest {
  account_id: number;
  ticker_id: number;
  option_code: string;
  opened_date: string;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date: string;
  original_quantity: number;
}

export interface ExpireOptionResponse {
  closed_updated: number;
  expired_transaction_id: number;
  expired_transaction_type: string;
}

export interface AssignOptionRequest {
  account_id: number;
  ticker_id: number;
  option_code: string;
  opened_date: string;
  option_type?: string | null;
  strike_price?: number | null;
  expiration_date?: string | null;
  original_quantity: number;
  assignment_date: string;
}

export interface AssignOptionResponse {
  closed_updated: number;
  assigned_transaction_id: number;
  stock_transaction_id: number;
  stock_transaction_type: string;
}

export interface TransactionWithDetails {
  id: number;
  account_code: string;
  ticker_symbol: string;
  transaction_type: string;
  quantity: number;
  price: number;
  cost: number;
  fees: number | null;
  date: string;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_code: string | null;
  status: string | null;
  source: string | null;
}

export interface PaginatedTransactions {
  items: TransactionWithDetails[];
  total: number;
  limit: number;
  offset: number;
}

export interface Position {
  account_id: number;
  account_code: string;
  ticker_id: number;
  ticker_symbol: string;
  status: string | null;
  quantity: number;
  avg_cost: number;
  total_cost: number;
  current_price: number | null;
  current_price_date: string | null;
  total_value: number;
  underlying_symbol?: string | null;
  underlying_price?: number | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  opened_date: string | null;
  option_code: string | null;
}

export interface PortfolioSummary {
  total_invested: number;
  total_deposit: number;
  total_positions: number;
  accounts_count: number;
  tickers_count: number;
}

export interface YieldMetrics {
  annual_yield_rate: number;
}

export interface AccountPerformance {
  account_id: number;
  account_code: string;
  total_value: number;
  /** Broker-reported net-liquidation balance (Value A). Null for accounts without a SnapTrade link. */
  broker_balance: number | null;
  total_cost: number;
  total_deposit: number;
  profit: number;
  annual_yield_rate: number;
  /** Trailing-12-month money-weighted return (XIRR), percent. Null when not computable. */
  last_12m_profit_rate: number | null;
  open_positions: number;
}

export interface ApiUsageSource {
  source: string;
  record_count: number;
  symbol_count: number;
  last_fetched_at: string | null;
}

export interface ApiUsageDaily {
  price_date: string;
  fetch_count: number;
  symbol_count: number;
}

export interface ApiUsageRecentFetch {
  symbol: string;
  price_date: string;
  price: number;
  source: string;
  fetched_at: string;
}

export interface ProviderRequestMetrics {
  provider: string;
  requests_today: number;
  success_today: number;
  failed_today: number;
  success_rate: number;
  failed_rate: number;
}

export interface ApiUsageSummary {
  as_of?: string;
  total_records: number;
  unique_symbols: number;
  cached_symbols: string[];
  records_today: number;
  earliest_price_date: string | null;
  latest_price_date: string | null;
  providers: {
    fmp_enabled: boolean;
    twelve_data_enabled: boolean;
    yahoo_finance_enabled: boolean;
  };
  provider_metrics: ProviderRequestMetrics[];
  by_source: ApiUsageSource[];
  daily: ApiUsageDaily[];
  recent_fetches: ApiUsageRecentFetch[];
}

export interface CacheCoverage {
  symbol: string;
  start_date: string;
  end_date: string;
  total_days: number;
  cached_days: number;
  coverage_rate: number;
  trading_dates: string[];
  cached_dates: string[];
}

export interface CachePriceTrendPoint {
  date: string;
  price: number;
}

export interface CachePriceTrend {
  symbol: string;
  start_date: string;
  end_date: string;
  points: CachePriceTrendPoint[];
  min_price: number | null;
  max_price: number | null;
  latest_price: number | null;
  change_pct: number | null;
}

export interface CacheClearRequest {
  scope: 'today' | 'all' | 'older_than_days' | 'symbol';
  days?: number;
  symbol?: string;
}

export interface CacheClearResponse {
  scope: string;
  deleted_rows: number;
}

export interface PrefetchRequest {
  symbols: string[];
  days?: number;
}

export interface PrefetchSymbolBars {
  symbol: string;
  bars: number;
}

export interface PrefetchResponse {
  requested_symbols: number;
  cached_symbols: number;
  bars_cached: number;
  start_date: string;
  end_date: string;
  symbol_bars: PrefetchSymbolBars[];
}

export interface ImportResult {
  accounts_created: number;
  tickers_created: number;
  transactions_imported: number;
}

export interface TickerRealizedPnl {
  account_id: number;
  account_code: string;
  ticker_id: number;
  ticker_symbol: string;
  realized_pnl: number;
  realized_stock_pnl: number;
  realized_option_pnl: number;
}

export interface TransactionFilter {
  account_id?: number;
  ticker_id?: number;
  symbol?: string;
  transaction_type?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
  include_cash_equivalents?: boolean;
}

// --- SnapTrade auto-import ---

export interface SnapTradeRegisterResult {
  status: string; // "ready" | "registered" | "already_registered"
  mode?: string; // "personal" | "commercial"
  detail?: string;
  user_id?: string;
}

export interface SnapTradeAccount {
  snaptrade_account_id: string;
  institution_name: string | null;
  number: string | null;
  name: string | null;
  linked_account_code: string | null;
}

export interface SnapTradePerAccount {
  account: string;
  activities_pulled: number;
  normalized: number;
  earliest: string | null;
  latest: string | null;
  start_date: string | null;
}

export interface SnapTradeImportResult {
  // apply mode
  applied?: boolean;
  plain_legs_imported?: number;
  accounts_created?: number;
  tickers_created?: number;
  rolls_reconstructed?: number;
  rolls_already_present?: number;
  rolls_fallback_raw?: number;
  historical_stock_legs_closed?: number;
  // preview (dry-run) mode
  dry_run?: boolean;
  total_legs?: number;
  rolls_detected?: number;
  plain_legs_to_upsert?: number;
  per_account?: SnapTradePerAccount[];
}
