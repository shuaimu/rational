/**
 * Maps leveraged ETFs to their underlying ticker and leverage multiplier.
 *
 * A multiplier of 2 means the ETF moves 2x the underlying (e.g. AAPU ≈ 2× AAPL).
 * Inverse ETFs use negative multipliers (e.g. SQQQ = -3× QQQ).
 */

interface LeverageEntry {
  underlying: string;
  multiplier: number;
}

const LEVERAGE_MAP: Record<string, LeverageEntry> = {
  // AAPL family
  AAPU: { underlying: 'AAPL', multiplier: 2 },

  // AMD family
  AMDD: { underlying: 'AMD', multiplier: 2 },

  // AMZN family
  AMZU: { underlying: 'AMZN', multiplier: 2 },

  // MSFT family
  MSFU: { underlying: 'MSFT', multiplier: 2 },

  // QQQ / Nasdaq family
  QLD: { underlying: 'QQQ', multiplier: 2 },
  TQQQ: { underlying: 'QQQ', multiplier: 3 },
  SQQQ: { underlying: 'QQQ', multiplier: -3 },
  PSQ: { underlying: 'QQQ', multiplier: -1 },

  // SPY / S&P 500 family
  UPRO: { underlying: 'SPY', multiplier: 3 },

  // Semiconductors
  SOXL: { underlying: 'SOXL_BASE', multiplier: 3 },
  SOXS: { underlying: 'SOXL_BASE', multiplier: -3 },

  // FANG+
  FNGU: { underlying: 'FNGU_BASE', multiplier: 3 },
  FNGD: { underlying: 'FNGU_BASE', multiplier: -3 },
  FNGO: { underlying: 'FNGU_BASE', multiplier: 2 },

  // Health care
  CURE: { underlying: 'CURE_BASE', multiplier: 3 },

  // Financials
  FAS: { underlying: 'FAS_BASE', multiplier: 3 },

  // China
  YINN: { underlying: 'YINN_BASE', multiplier: 3 },
};

/**
 * Returns the underlying symbol and multiplier for a ticker.
 * Non-leveraged tickers map to themselves with multiplier 1.
 */
export function getLeverage(symbol: string): { underlying: string; multiplier: number } {
  const entry = LEVERAGE_MAP[symbol];
  if (entry) {
    return entry;
  }
  return { underlying: symbol, multiplier: 1 };
}

/**
 * Returns the display label for an underlying group.
 * If the group contains only one ticker that IS the underlying, just return it.
 * Otherwise return a descriptive label.
 */
export function getUnderlyingLabel(underlying: string, memberSymbols: string[]): string {
  if (memberSymbols.length === 1 && memberSymbols[0] === underlying) {
    return underlying;
  }
  // For synthetic underlyings like SOXL_BASE, use the first member
  if (underlying.endsWith('_BASE')) {
    return memberSymbols.sort().join(' / ');
  }
  return underlying;
}
