/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const version: () => [number, number];
export const positions: (a: any, b: any, c: any, d: any, e: number, f: number) => [number, number, number];
export const realized_pnl: (a: any, b: any, c: any, d: number) => [number, number, number];
export const plan_roll_option: (a: any, b: any) => [number, number, number];
export const plan_close_option: (a: any, b: any) => [number, number, number];
export const plan_expire_option: (a: any, b: any) => [number, number, number];
export const plan_assign_option: (a: any, b: any) => [number, number, number];
export const account_performance: (a: any, b: any, c: any, d: any, e: any, f: number, g: number) => [number, number, number];
export const account_performance_snapshot: (a: any, b: any, c: any, d: any, e: any, f: number, g: number, h: any, i: any) => [number, number, number];
export const portfolio_summary: (a: any, b: any, c: any) => [number, number, number];
export const portfolio_yield: (a: any, b: any, c: any, d: any, e: number, f: number) => [number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
