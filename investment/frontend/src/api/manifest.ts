import type { Account, Ticker, Transaction } from './types';
export interface ContentRef { id: string; bytes: number }
export interface ContentDoc { id: string; payload: string }
export interface PortfolioHead { id: string; format: number; sequence: number; public_root: ContentRef; private_root: ContentRef; command: ContentRef; next_ids: Record<string, number | null> }
export interface Snapshot { account_id: number; as_of_date: string; computed_value: number; broker_value: number | null; created_at: string | null }
export interface Split { symbol: string; split_date: string; multiplier: number }
export interface BrokerBalance { account_id: number; balance: number }
export type LedgerRow = Transaction & { source: string | null; created_at: string | null; updated_at: string | null };
export interface PublicTables { accounts: Account[]; tickers: Ticker[]; transactions: LedgerRow[]; account_value_snapshots: Snapshot[]; ticker_splits: Split[]; broker_balances: BrokerBalance[] }
export interface LocalGeneration { version: number; root: ContentRef; tables: PublicTables }
export class IncompleteManifest extends Error { constructor() { super('Waiting for portfolio records.'); } }
export class InvalidManifest extends Error { constructor() { super('Portfolio verification failed. The previous complete version is retained.'); } }
const fields: Record<keyof PublicTables, string[]> = {
  accounts: ['id', 'code', 'name', 'account_type'], tickers: ['id', 'symbol', 'name'],
  transactions: ['id', 'account_id', 'ticker_id', 'transaction_type', 'quantity', 'price', 'cost', 'fees', 'date', 'option_type', 'strike_price', 'expiration_date', 'option_code', 'status', 'source', 'created_at', 'updated_at'],
  ticker_splits: ['symbol', 'split_date', 'multiplier'], account_value_snapshots: ['account_id', 'as_of_date', 'computed_value', 'broker_value', 'created_at'], broker_balances: ['account_id', 'balance'],
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
function check(condition: unknown): asserts condition { if (!condition) throw new InvalidManifest(); }
const safeId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): v is string => typeof v === 'string';
const nullableText = (v: unknown) => v === null || text(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const nullableNumber = (v: unknown) => v === null || number(v);
const date = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export async function digest(text: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((n) => n.toString(16).padStart(2, '0')).join(''); }
function reference(v: unknown, prefix: string): v is ContentRef { return exact(v, ['id', 'bytes']) && text(v.id) && new RegExp(`^${prefix}_[0-9a-f]{64}$`).test(v.id) && typeof v.bytes === 'number' && Number.isInteger(v.bytes) && v.bytes > 0 && v.bytes <= 32768; }
export function validateHead(v: unknown): asserts v is PortfolioHead {
  check(exact(v, ['id', 'format', 'sequence', 'public_root', 'private_root', 'command', 'next_ids']) && v.id === 'portfolio' && v.format === 1 && safeId(v.sequence) && reference(v.public_root, 'm') && reference(v.private_root, 'm') && reference(v.command, 'c') && exact(v.next_ids, ['account', 'ticker', 'transaction', 'brokerage_user']) && Object.values(v.next_ids).every((n) => n === null || safeId(n)));
}
function rowValid(table: keyof PublicTables, row: unknown): row is Record<string, unknown> {
  if (!exact(row, fields[table])) return false;
  switch (table) {
    case 'accounts': return safeId(row.id) && text(row.code) && nullableText(row.name) && nullableText(row.account_type);
    case 'tickers': return safeId(row.id) && text(row.symbol) && nullableText(row.name);
    case 'transactions': return safeId(row.id) && safeId(row.account_id) && safeId(row.ticker_id) && text(row.transaction_type) && number(row.quantity) && number(row.price) && number(row.cost) && nullableNumber(row.fees) && nullableNumber(row.strike_price) && date(row.date) && (row.expiration_date === null || date(row.expiration_date)) && ['option_type','option_code','status','source','created_at','updated_at'].every((key) => nullableText(row[key]));
    case 'ticker_splits': return text(row.symbol) && date(row.split_date) && number(row.multiplier) && (row.multiplier as number) > 0;
    case 'account_value_snapshots': return safeId(row.account_id) && date(row.as_of_date) && number(row.computed_value) && nullableNumber(row.broker_value) && nullableText(row.created_at);
    case 'broker_balances': return safeId(row.account_id) && number(row.balance);
  }
}
export function validateTables(tables: PublicTables): void {
  const keys: Record<keyof PublicTables, string[]> = { accounts:['id'],tickers:['id'],transactions:['id'],ticker_splits:['symbol','split_date'],account_value_snapshots:['account_id','as_of_date'],broker_balances:['account_id'] };
  for (const table of Object.keys(fields) as (keyof PublicTables)[]) {
    const seen = new Set<string>();
    check(Array.isArray(tables[table]));
    for (const row of tables[table]) {
      check(rowValid(table, row));
      const key = JSON.stringify(keys[table].map((key) => row[key]));
      check(!seen.has(key)); seen.add(key);
    }
  }
  check(new Set(tables.accounts.map((r) => r.code)).size === tables.accounts.length);
  check(new Set(tables.tickers.map((r) => r.symbol)).size === tables.tickers.length);
  const accounts = new Set(tables.accounts.map((r) => r.id));
  const tickers = new Set(tables.tickers.map((r) => r.id));
  check(tables.transactions.every((r) => accounts.has(r.account_id) && tickers.has(r.ticker_id)));
  check([...tables.account_value_snapshots, ...tables.broker_balances].every((r) => accounts.has(r.account_id)));
}

export async function materialize(head: PortfolioHead, get: (id: string) => Promise<ContentDoc | null>): Promise<LocalGeneration> {
  validateHead(head);
  const tables: Record<string, unknown[]> = Object.fromEntries(Object.keys(fields).map((table) => [table, []]));
  const seen = new Set<string>(); let bytes = 0;
  async function load(ref: ContentRef, prefix: string) {
    check(reference(ref, prefix) && !seen.has(ref.id)); seen.add(ref.id); bytes += ref.bytes;
    check(seen.size <= 8192 && bytes <= 64 * 1024 * 1024);
    const doc = await get(ref.id);
    if (!doc) throw new IncompleteManifest();
    check(exact(doc, ['id', 'payload']) && doc.id === ref.id && text(doc.payload));
    check(new TextEncoder().encode(doc.payload).length === ref.bytes && `${prefix}_${await digest(doc.payload)}` === ref.id);
    try { return JSON.parse(doc.payload) as unknown; } catch { throw new InvalidManifest(); }
  }
  async function walk(ref: ContentRef, depth: number): Promise<void> {
    check(depth <= 16);
    const manifest = await load(ref, 'm');
    check(exact(manifest, ['format','visibility','children']) && manifest.format === 1 && manifest.visibility === 'public' && Array.isArray(manifest.children) && manifest.children.length <= 16);
    for (const child of manifest.children) {
      check(object(child));
      if (child.kind === 'manifest') {
        check(exact(child, ['kind','content']) && reference(child.content, 'm'));
        await walk(child.content, depth + 1);
      } else {
        check(exact(child, ['kind','table','bucket','content']) && child.kind === 'partition' && text(child.table) && Object.hasOwn(fields, child.table) && text(child.bucket) && child.bucket.length <= 256 && reference(child.content, 'p'));
        const part = await load(child.content, 'p');
        check(exact(part, ['format','table','bucket','rows']) && part.format === 1 && part.table === child.table && part.bucket === child.bucket && Array.isArray(part.rows) && part.rows.length > 0);
        tables[child.table].push(...part.rows);
      }
    }
  }
  await walk(head.public_root, 0);
  const typed = tables as unknown as PublicTables;
  validateTables(typed);
  typed.transactions.sort((a, b) => a.id - b.id);
  typed.accounts.sort((a, b) => a.code.localeCompare(b.code));
  typed.tickers.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { version: head.sequence, root: head.public_root, tables: typed };
}
