/** Shared, strict Monarch contract. Source IDs and decimal amounts stay strings until mapping. */
export type CategoryKind = "income" | "expense" | "transfer";
export type TagEncoding = "single" | "comma" | "semicolon";
export interface SourceRow {
  line: number;
  date: string;
  merchant: string;
  category: string;
  account: string;
  statement: string;
  notes: string;
  amount: string;
  tags: string;
  owner: string;
  reviewed: "" | "Reviewed" | "Needs Review";
  sourceId: string;
}
export interface BalanceRow {
  line: number;
  date: string;
  balance: string;
  account: string;
}
export interface CsvRecord {
  line: number;
  cells: string[];
}
export interface AccountPlan {
  source: string;
  accountId: string | null;
  name: string;
  type: string;
  currency: string;
  identityConfirmed: boolean;
  balance: { date: string; amount: string; sign: 1 | -1 } | null;
  opening: string;
  replaceOpening: boolean;
  expectedRevision: string | null;
}
export interface MonarchManifest {
  version: 1;
  accounts: AccountPlan[];
  categories: Record<string, CategoryKind>;
  tagEncoding: TagEncoding;
  rowCount: number;
  chunkHashes: string[];
}
export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "crypto",
  "loan",
  "real_estate",
  "vehicle",
  "other_asset",
  "other_liability",
];
export function problem(line: number, message: string): never {
  throw new Error(`Line ${line}: ${message}`);
}

/** RFC 4180 state machine. Reject malformed quotes/width; never drop unreadable rows. */
export function strictCsv(input: string): CsvRecord[] {
  const text = input.replace(/^\uFEFF/u, "");
  if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
    throw new Error("CSV exceeds 32 MiB.");
  const records: CsvRecord[] = [];
  let cells: string[] = [],
    cell = "",
    state: "start" | "plain" | "quoted" | "closed" = "start";
  let line = 1,
    start = 1;
  const finish = () => {
    cells.push(cell);
    records.push({ line: start, cells });
    cells = [];
    cell = "";
    state = "start";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (state === "quoted") {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else state = "closed";
      } else {
        cell += ch;
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
      }
      continue;
    }
    if (ch === ",") {
      cells.push(cell);
      cell = "";
      state = "start";
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      finish();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      start = line;
      continue;
    }
    if (state === "closed") problem(line, "unexpected text after a closing quote");
    if (ch === '"') {
      if (state !== "start") problem(line, "quote inside an unquoted field");
      state = "quoted";
    } else {
      cell += ch;
      state = "plain";
    }
  }
  if (state === "quoted") problem(start, "unterminated quoted field");
  if (cell !== "" || cells.length || state !== "start") finish();
  if (!records.length) throw new Error("CSV is empty.");
  const width = records[0]!.cells.length;
  for (const record of records)
    if (record.cells.length !== width)
      problem(record.line, `expected ${width} columns, found ${record.cells.length}`);
  return records;
}
function table(text: string, required: string[], optional: string[] = []) {
  const records = strictCsv(text),
    headers = records.shift()!.cells;
  if (new Set(headers).size !== headers.length) throw new Error("Duplicate column names.");
  for (const name of required)
    if (!headers.includes(name)) throw new Error(`Missing ${name} column.`);
  for (const name of headers)
    if (![...required, ...optional].includes(name))
      throw new Error(`Unrecognized column ${name}; review the export format.`);
  return records.map((record) => ({
    line: record.line,
    get: (name: string) => record.cells[headers.indexOf(name)] ?? "",
  }));
}
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
const DIGITS: Record<string, number> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};
export function decimalMinor(value: string, currency: string): number {
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error("Choose a three-letter currency.");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match)
    throw new Error("Expected a signed decimal amount without currency symbols or separators.");
  const digits = DIGITS[currency] ?? 2,
    fraction = match[3] ?? "";
  if (fraction.length > digits && /[1-9]/u.test(fraction.slice(digits)))
    throw new Error(`Amount has more than ${digits} decimal places for ${currency}.`);
  const amount =
    BigInt(match[2]!) * 10n ** BigInt(digits) +
    BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Amount exceeds the safe integer range.");
  return Number(amount) * (match[1] ? -1 : 1);
}
export function validateSource(row: SourceRow): void {
  if (!row || !Number.isSafeInteger(row.line) || row.line < 2)
    throw new Error("Invalid source line.");
  for (const key of [
    "date",
    "merchant",
    "category",
    "account",
    "statement",
    "notes",
    "amount",
    "tags",
    "owner",
    "reviewed",
    "sourceId",
  ] as const) {
    if (typeof row[key] !== "string") problem(row.line, `invalid ${key}`);
  }
  if (!validDate(row.date)) problem(row.line, "invalid calendar date");
  if (!row.account.trim() || !row.merchant.trim())
    problem(row.line, "account and merchant are required");
  if (!/^-?\d+(?:\.\d+)?$/u.test(row.amount)) problem(row.line, "invalid decimal amount");
  if (!["", "Reviewed", "Needs Review"].includes(row.reviewed))
    problem(row.line, "unrecognized Reviewed value");
  for (const [key, limit] of [
    ["merchant", 500],
    ["category", 200],
    ["account", 200],
    ["notes", 2000],
    ["statement", 4000],
    ["owner", 500],
    ["sourceId", 256],
    ["tags", 4000],
  ] as const) {
    if (row[key].length > limit)
      problem(row.line, `${key} exceeds ${limit} characters; no text has been truncated`);
  }
}
export function parseMonarch(text: string): SourceRow[] {
  const rows = table(
    text,
    ["Date", "Merchant", "Category", "Account", "Original Statement", "Notes", "Amount", "Tags"],
    ["Owner", "Reviewed", "Id"],
  );
  return rows.map(({ line, get }) => {
    const row: SourceRow = {
      line,
      date: get("Date"),
      merchant: get("Merchant"),
      category: get("Category"),
      account: get("Account"),
      statement: get("Original Statement"),
      notes: get("Notes"),
      amount: get("Amount"),
      tags: get("Tags"),
      owner: get("Owner"),
      reviewed: get("Reviewed") as SourceRow["reviewed"],
      sourceId: get("Id"),
    };
    validateSource(row);
    return row;
  });
}
export function parseBalances(text: string): BalanceRow[] {
  return table(text, ["Date", "Balance", "Account"]).map(({ line, get }) => {
    const row = { line, date: get("Date"), balance: get("Balance"), account: get("Account") };
    if (!validDate(row.date) || !row.account.trim() || !/^-?\d+(?:\.\d+)?$/u.test(row.balance))
      problem(line, "invalid balance date, account or amount");
    return row;
  });
}
export function tagsFor(raw: string, encoding: TagEncoding): string[] {
  const tags =
    raw === ""
      ? []
      : raw
          .split(encoding === "comma" ? "," : encoding === "semicolon" ? ";" : /$^/u)
          .map((tag) => tag.trim());
  if (tags.some((tag) => !tag || tag.length > 200) || tags.length > 64)
    throw new Error("Invalid tags; choose the export's separator or keep the raw label.");
  return [...new Set(tags)];
}
export function checkedSum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total))
      throw new Error("Balance exceeds the safe integer range.");
  }
  return total;
}
export function normalizeSource(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
export function legacyKey(row: SourceRow, amount: number): string {
  return JSON.stringify([
    row.account,
    row.date,
    amount,
    normalizeSource(row.statement || row.merchant),
  ]);
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function validateManifest(manifest: MonarchManifest): void {
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.accounts) ||
    !manifest.accounts.length ||
    manifest.accounts.length > 200 ||
    !manifest.categories ||
    !["single", "comma", "semicolon"].includes(manifest.tagEncoding)
  )
    throw new Error("Invalid import manifest.");
  if (
    !Number.isSafeInteger(manifest.rowCount) ||
    manifest.rowCount < 1 ||
    manifest.rowCount > 200000 ||
    !Array.isArray(manifest.chunkHashes) ||
    manifest.chunkHashes.length > 2000 ||
    !manifest.chunkHashes.length ||
    manifest.chunkHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))
  )
    throw new Error("Invalid upload size or checksums.");
  const names = new Set<string>(),
    destinations = new Set<string>();
  for (const plan of manifest.accounts) {
    if (
      !plan.identityConfirmed ||
      !plan.source?.trim() ||
      !plan.name?.trim() ||
      plan.name.length > 200 ||
      names.has(plan.source) ||
      !ACCOUNT_TYPES.includes(plan.type)
    )
      throw new Error(
        "Confirm every account identity and type; ambiguous source names must be resolved before import.",
      );
    names.add(plan.source);
    if (plan.accountId) {
      if (destinations.has(plan.accountId))
        throw new Error("Two source accounts cannot silently merge into one destination.");
      destinations.add(plan.accountId);
    }
    decimalMinor(plan.opening, plan.currency);
    if (plan.balance) {
      if (!validDate(plan.balance.date) || ![1, -1].includes(plan.balance.sign))
        throw new Error("Invalid balance evidence.");
      decimalMinor(plan.balance.amount, plan.currency);
    }
  }
  for (const kind of Object.values(manifest.categories))
    if (!["income", "expense", "transfer"].includes(kind))
      throw new Error("Choose each category's kind.");
}
