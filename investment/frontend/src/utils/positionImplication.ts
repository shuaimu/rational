import type { Position } from '../api/types';
import { isBeforeToday } from './date';
import { getLeverage } from './leverageMap';

export interface OptionStockImplication {
  likelyBuy: number;
  likelySell: number;
  unlikelyBuy: number;
  unlikelySell: number;
  potentialIBuy: number;
  potentialISell: number;
}

const ZERO_IMPLICATION: OptionStockImplication = {
  likelyBuy: 0,
  likelySell: 0,
  unlikelyBuy: 0,
  unlikelySell: 0,
  potentialIBuy: 0,
  potentialISell: 0,
};

function getPotentialIThreshold(pos: Position): number {
  const { multiplier } = getLeverage(pos.ticker_symbol);
  return 0.15 * Math.max(1, Math.abs(multiplier));
}

function isPotentialIBuy(pos: Position): boolean {
  const strike = pos.strike_price;
  const currentPrice = pos.current_price;
  if (strike == null || currentPrice == null || currentPrice <= 0) {
    return false;
  }

  return Math.abs(strike - currentPrice) / currentPrice <= getPotentialIThreshold(pos);
}

function isPotentialISell(pos: Position): boolean {
  const strike = pos.strike_price;
  const currentPrice = pos.current_price;
  const optionType = pos.option_type?.trim().toUpperCase();
  if (optionType !== 'C' && optionType !== 'CALL') {
    return false;
  }
  if (pos.quantity >= 0 || strike == null || currentPrice == null || currentPrice <= 0) {
    return false;
  }

  return strike <= currentPrice * (1 - getPotentialIThreshold(pos));
}

function normType(t: string | null | undefined): 'C' | 'P' | null {
  const u = t?.trim().toUpperCase();
  if (u === 'C' || u === 'CALL') return 'C';
  if (u === 'P' || u === 'PUT') return 'P';
  return null;
}

/**
 * Net matched CONVERSIONS for exposure only. A long put + short call at the same strike &
 * expiry in the same account locks the sale of the covered shares at that strike, so those
 * shares carry no effective *or* potential exposure. For each such pair, this removes the
 * covered quantity from the underlying long-stock lot and from the two option legs, so the
 * normal stock-exposure math already yields the right numbers. Only what the stock can cover
 * is netted (an uncovered pair stays a synthetic short). Returns a copy — callers must keep
 * the ORIGINAL positions for displaying holdings; this feeds the exposure calc alone.
 */
export function netConversions(positions: Position[]): Position[] {
  const out = positions.map((p) => ({ ...p }));
  for (const put of out) {
    if (!put.option_code || normType(put.option_type) !== 'P' || put.quantity <= 0) continue;
    const call = out.find(
      (c) =>
        c.option_code != null &&
        normType(c.option_type) === 'C' &&
        c.quantity < 0 &&
        c.account_id === put.account_id &&
        c.ticker_symbol === put.ticker_symbol &&
        c.strike_price === put.strike_price &&
        c.expiration_date === put.expiration_date,
    );
    if (!call) continue;
    const pairQty = Math.min(put.quantity, Math.abs(call.quantity));
    if (pairQty <= 0) continue;

    let toCover = pairQty;
    for (const stock of out) {
      if (toCover <= 0) break;
      if (stock.option_code || stock.account_id !== put.account_id || stock.ticker_symbol !== put.ticker_symbol) continue;
      if (stock.quantity <= 0) continue;
      const take = Math.min(toCover, stock.quantity);
      stock.quantity -= take;
      toCover -= take;
    }
    const covered = pairQty - toCover; // only the stock-covered portion is a locked sale
    if (covered <= 0) continue;
    put.quantity -= covered;
    call.quantity += covered; // call qty is negative; += shrinks the magnitude
  }
  // Drop fully-consumed option legs so they contribute nothing to exposure.
  return out.filter((p) => !(p.option_code && Math.abs(p.quantity) < 1e-9));
}

export function getOptionStockImplication(pos: Position): OptionStockImplication {
  if (!pos.option_code) {
    return ZERO_IMPLICATION;
  }

  const rawOptionType = pos.option_type?.trim().toUpperCase();
  const optionType =
    rawOptionType === 'C' || rawOptionType === 'CALL'
      ? 'C'
      : rawOptionType === 'P' || rawOptionType === 'PUT'
        ? 'P'
        : null;
  const strike = pos.strike_price;
  const underlyingPrice = pos.current_price;
  if (!optionType || strike == null || underlyingPrice == null) {
    return ZERO_IMPLICATION;
  }

  const isExpired = isBeforeToday(pos.expiration_date);

  const isInTheMoney =
    (optionType === 'C' && underlyingPrice > strike) || (optionType === 'P' && underlyingPrice < strike);

  const underlyingEffect = optionType === 'C' ? pos.quantity : -pos.quantity;
  if (underlyingEffect === 0) {
    return ZERO_IMPLICATION;
  }

  // For expired options, only ITM contracts should imply exercise/assignment.
  if (isExpired && !isInTheMoney) {
    return ZERO_IMPLICATION;
  }

  if (isInTheMoney) {
    if (underlyingEffect > 0) {
      return {
        likelyBuy: underlyingEffect,
        likelySell: 0,
        unlikelyBuy: 0,
        unlikelySell: 0,
        potentialIBuy: isPotentialIBuy(pos) ? underlyingEffect : 0,
        potentialISell: 0,
      };
    }
    return {
      likelyBuy: 0,
      likelySell: Math.abs(underlyingEffect),
      unlikelyBuy: 0,
      unlikelySell: 0,
      potentialIBuy: 0,
      potentialISell: isPotentialISell(pos) ? Math.abs(underlyingEffect) : 0,
    };
  }

  if (underlyingEffect > 0) {
    return {
      likelyBuy: 0,
      likelySell: 0,
      unlikelyBuy: underlyingEffect,
      unlikelySell: 0,
      potentialIBuy: isPotentialIBuy(pos) ? underlyingEffect : 0,
      potentialISell: 0,
    };
  }

  return {
    likelyBuy: 0,
    likelySell: 0,
    unlikelyBuy: 0,
    unlikelySell: Math.abs(underlyingEffect),
    potentialIBuy: 0,
    potentialISell: isPotentialISell(pos) ? Math.abs(underlyingEffect) : 0,
  };
}
