const CASH_EQUIVALENT_SECURITY_SYMBOLS = new Set(['BOXX', 'SPAXX']);

export function normalizeSymbol(symbol: string | null | undefined): string {
  return (symbol ?? '').trim().toUpperCase();
}

export function isCashEquivalentSecuritySymbol(symbol: string | null | undefined): boolean {
  return CASH_EQUIVALENT_SECURITY_SYMBOLS.has(normalizeSymbol(symbol));
}

export function isNonPositionCashSymbol(symbol: string | null | undefined): boolean {
  const normalized = normalizeSymbol(symbol);
  return normalized === 'CASH' || isCashEquivalentSecuritySymbol(normalized);
}
