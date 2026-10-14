/* tslint:disable */
/* eslint-disable */

/**
 * Per-account performance. Returns `AccountPerformance[]`.
 * `last_12m_profit_rate` is approximate until historical prices are wired.
 */
export function account_performance(txns: any, accounts: any, tickers: any, prices: any, broker_balances: any, today: string): any;

export function account_performance_snapshot(txns: any, accounts: any, tickers: any, prices: any, broker_balances: any, today: string, historical: any, snapshots: any): any;

/**
 * Assign a full short option lot (spawns the stock leg). Returns `{ close_ids, inserts }`.
 */
export function plan_assign_option(txns: any, req: any): any;

/**
 * Close a full option lot. Returns `{ close_ids, inserts }`.
 */
export function plan_close_option(txns: any, req: any): any;

/**
 * Expire a full option lot worthless. Returns `{ close_ids, inserts }`.
 */
export function plan_expire_option(txns: any, req: any): any;

/**
 * Roll a full-lot short option. Returns `{ close_ids, inserts }`.
 */
export function plan_roll_option(txns: any, req: any): any;

export function portfolio_summary(txns: any, accounts: any, tickers: any): any;

export function portfolio_yield(txns: any, accounts: any, tickers: any, prices: any, today: string): any;

/**
 * Enriched positions (compute + market-value enrichment). Returns `Position[]`.
 */
export function positions(txns: any, accounts: any, tickers: any, prices: any, account_id: number | null | undefined, include_closed: boolean): any;

/**
 * Realized P&L per ticker. Returns `TickerRealizedPnl[]`.
 */
export function realized_pnl(txns: any, accounts: any, tickers: any, account_id?: number | null): any;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly version: () => [number, number];
    readonly positions: (a: any, b: any, c: any, d: any, e: number, f: number) => [number, number, number];
    readonly realized_pnl: (a: any, b: any, c: any, d: number) => [number, number, number];
    readonly plan_roll_option: (a: any, b: any) => [number, number, number];
    readonly plan_close_option: (a: any, b: any) => [number, number, number];
    readonly plan_expire_option: (a: any, b: any) => [number, number, number];
    readonly plan_assign_option: (a: any, b: any) => [number, number, number];
    readonly account_performance: (a: any, b: any, c: any, d: any, e: any, f: number, g: number) => [number, number, number];
    readonly account_performance_snapshot: (a: any, b: any, c: any, d: any, e: any, f: number, g: number, h: any, i: any) => [number, number, number];
    readonly portfolio_summary: (a: any, b: any, c: any) => [number, number, number];
    readonly portfolio_yield: (a: any, b: any, c: any, d: any, e: number, f: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
