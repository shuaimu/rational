import { decimalMinor } from "./monarch.ts";
/** Provider account identities are explicit; names and balances are never join keys. */
export interface ProviderAccount {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  balance: number | null;
}

export interface AccountMapping {
  providerAccountId: string;
  accountId: string;
  cursor: string;
  lastSyncedAt: number;
}

export type AccountSelection = { providerAccountId: string; accountId: string } |
  { providerAccountId: string; create: true };

/** Only types whose balance semantics we support can become new accounts. */
export function providerAccountType(provider: ProviderAccount): string | null {
  if (!/^[A-Z]{3}$/.test(provider.currency)) return null;
  if (provider.type === "depository") return provider.subtype === "savings" || provider.subtype === "cd" || provider.subtype === "money market" ? "savings" : "checking";
  return ({ credit: "credit", loan: "loan", investment: "investment" } as Record<string, string>)[provider.type] ?? null;
}

export function providerAccounts(value: unknown): ProviderAccount[] {
  const accounts = (value as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) throw new Error("The institution did not return accounts.");
  return accounts.map((entry) => {
    if (typeof entry?.account_id !== "string" || typeof entry.name !== "string" || typeof entry.type !== "string") {
      throw new Error("The institution returned an invalid account.");
    }
    const current = entry.balances?.current;
    const currency = typeof entry.balances?.iso_currency_code === "string" ? entry.balances.iso_currency_code : "";
    const minor = typeof current === "number" && Number.isFinite(current) && currency ? decimalMinor(String(current), currency) : null;
    if (minor !== null && !Number.isSafeInteger(minor)) throw new Error("The institution returned an invalid balance.");
    return {
      id: entry.account_id, name: entry.name,
      mask: typeof entry.mask === "string" ? entry.mask : null,
      type: entry.type, subtype: typeof entry.subtype === "string" ? entry.subtype : null,
      currency,
      balance: minor === null ? null : (["credit", "loan"].includes(entry.type) ? -minor : minor),
    };
  });
}

export function validateMappings(input: unknown, available: readonly ProviderAccount[]): AccountMapping[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw new Error("Choose between 1 and 64 accounts.");
  const providerIds = new Set<string>();
  const accountIds = new Set<string>();
  return input.map((mapping) => {
    if (typeof mapping?.providerAccountId !== "string" || typeof mapping.accountId !== "string" || !mapping.accountId) {
      throw new Error("Each bank account needs a Rational account.");
    }
    if (!available.some((account) => account.id === mapping.providerAccountId)) throw new Error("The bank account is not part of this connection.");
    if (providerIds.has(mapping.providerAccountId) || accountIds.has(mapping.accountId)) throw new Error("Map each bank and Rational account only once.");
    providerIds.add(mapping.providerAccountId);
    accountIds.add(mapping.accountId);
    return { providerAccountId: mapping.providerAccountId, accountId: mapping.accountId, cursor: "", lastSyncedAt: 0 };
  });
}

export function compatibleAccount(provider: ProviderAccount, account: { type?: unknown; currency?: unknown }): boolean {
  const types: Record<string, string[]> = {
    depository: ["checking", "savings", "cash"], credit: ["credit"],
    loan: ["loan"], investment: ["investment", "crypto"],
  };
  return provider.currency !== "" && provider.currency === account.currency &&
    (types[provider.type]?.includes(String(account.type)) ?? false);
}

/** Replace one hidden reconciliation entry, rather than accumulating drift on every retry. */
export function reconciliationAmount(
  providerBalance: number,
  openingBalance: number,
  holdingsValue: number,
  otherAmounts: readonly number[],
): number {
  const amount = providerBalance - openingBalance - holdingsValue - otherAmounts.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(amount)) throw new Error("The reconciled balance is outside supported limits.");
  return amount;
}
