export interface HistoryRow { symbol: string; price_date: string; price: number; source: string; fetched_at: string | null; is_market_close: boolean }
export function historicalDigest(rows: HistoryRow[]): Promise<string>;
export function latestFromHistory(rows: HistoryRow[]): { symbol: string; latest_price_date: string; latest_price: number; source: string; fetched_at: string | null }[];
