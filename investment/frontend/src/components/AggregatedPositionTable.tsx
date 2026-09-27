import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { transactionsApi } from '../api/client';
import type {
  AssignOptionRequest,
  CloseOptionRequest,
  ExpireOptionRequest,
  Position,
  RollOptionRequest,
} from '../api/types';
import { formatDateOnly, formatLocalDateInputValue } from '../utils/date';
import { getLeverage, getUnderlyingLabel } from '../utils/leverageMap';
import { getOptionStockImplication, netConversions } from '../utils/positionImplication';

interface RealizedPnlBreakdown {
  stock: number;
  option: number;
}

interface AggregatedPositionTableProps {
  positions: Position[];
  mode?: 'default' | 'positions';
  percentageDenominator?: number | null;
  realizedPnlByTicker?: Map<number, RealizedPnlBreakdown>;
}

interface PositionGroup {
  key: string;
  tickerSymbol: string;
  underlyingSymbol: string;
  componentMultipliers: Map<string, number>;
  currentPrice: number | null;
  stockQuantity: number;
  likelyBuyQuantity: number;
  likelySellQuantity: number;
  potentialIBuyQuantity: number;
  potentialISellQuantity: number;
  unlikelyBuyQuantity: number;
  unlikelySellQuantity: number;
  effectiveExposure: number;
  potentialIExposure: number;
  potentialIIExposure: number;
  totalCost: number;
  totalValue: number;
  optionLots: number;
  lots: Position[];
}

interface RollFormState {
  rollDate: string;
  quantity: string;
  rollCost: string;
  closeFees: string;
  openFees: string;
  newOptionType: 'C' | 'P';
  newStrikePrice: string;
  newExpirationDate: string;
  newOptionCode: string;
  optionCodeEdited: boolean;
}

interface RollDialogState {
  position: Position;
  form: RollFormState;
  error: string | null;
}

interface CloseFormState {
  closeDate: string;
  quantity: string;
  cost: string;
  fees: string;
}

interface CloseDialogState {
  position: Position;
  form: CloseFormState;
  error: string | null;
}

interface ParsedDecimal {
  sign: bigint;
  digits: bigint;
  scale: number;
}

interface ExpireDialogState {
  position: Position;
  error: string | null;
}

interface AssignFormState {
  assignmentDate: string;
}

interface AssignDialogState {
  position: Position;
  form: AssignFormState;
  error: string | null;
}

function todayIsoDate(): string {
  return formatLocalDateInputValue();
}

function normalizeOptionType(optionType: string | null | undefined): 'C' | 'P' {
  const upper = optionType?.trim().toUpperCase();
  if (upper === 'P' || upper === 'PUT') {
    return 'P';
  }
  return 'C';
}

function buildOptionCode(expirationDate: string, optionType: 'C' | 'P', strike: string): string {
  const trimmedExpiration = expirationDate.trim();
  const trimmedStrike = strike.trim();
  if (!trimmedExpiration || !trimmedStrike) {
    return '';
  }

  const parts = trimmedExpiration.split('-');
  if (parts.length !== 3) {
    return '';
  }
  const [year, month, day] = parts;
  if (year.length !== 4 || month.length !== 2 || day.length !== 2) {
    return '';
  }

  return `${year.slice(-2)}${month}${day}${optionType}${trimmedStrike}`;
}

function parseApiError(error: unknown, fallback = 'Request failed'): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    const apiError = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (apiError) {
      return apiError;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function parseDecimalString(value: string): ParsedDecimal | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) {
    return null;
  }

  const [, signSymbol, integerPart = '', fractionalPart = '', leadingFractionalPart = ''] = match;
  const normalizedFractional = fractionalPart || leadingFractionalPart;
  const digitsText = `${integerPart || '0'}${normalizedFractional}`.replace(/^0+(?=\d)/, '');

  return {
    sign: signSymbol === '-' ? -1n : 1n,
    digits: BigInt(digitsText || '0'),
    scale: normalizedFractional.length,
  };
}

function formatScaledBigInt(value: bigint, scale: number): string {
  const isNegative = value < 0n;
  const absoluteValue = isNegative ? -value : value;
  let digits = absoluteValue.toString();

  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    const whole = digits.slice(0, -scale) || '0';
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    digits = fraction ? `${whole}.${fraction}` : whole;
  }

  return isNegative && digits !== '0' ? `-${digits}` : digits;
}

function calculateExactCost(quantityValue: string, priceValue: string): string | null {
  const quantity = parseDecimalString(quantityValue);
  const price = parseDecimalString(priceValue);
  if (!quantity || !price) {
    return null;
  }

  const product = quantity.sign * price.sign * quantity.digits * price.digits;
  return formatScaledBigInt(product, quantity.scale + price.scale);
}

function formatInstrument(pos: Position): string {
  if (!pos.option_code) {
    return 'Stock';
  }

  const optionSide = pos.option_type === 'C' ? 'Call' : pos.option_type === 'P' ? 'Put' : 'Option';
  const strike = pos.strike_price != null ? ` ${pos.strike_price}` : '';
  return `${optionSide}${strike} (${pos.option_code})`;
}

function sortLotsByOpenedDate(a: Position, b: Position): number {
  const aDate = a.opened_date ?? '';
  const bDate = b.opened_date ?? '';
  return aDate.localeCompare(bDate);
}

export function AggregatedPositionTable({
  positions,
  mode = 'default',
  percentageDenominator = null,
  realizedPnlByTicker,
}: AggregatedPositionTableProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rollDialog, setRollDialog] = useState<RollDialogState | null>(null);
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [expireDialog, setExpireDialog] = useState<ExpireDialogState | null>(null);
  const [assignDialog, setAssignDialog] = useState<AssignDialogState | null>(null);
  const positionsMode = mode === 'positions';

  const rollMutation = useMutation({
    mutationFn: transactionsApi.rollOption,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['yield-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-performance'] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: transactionsApi.closeOption,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['yield-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-performance'] });
    },
  });

  const expireMutation = useMutation({
    mutationFn: transactionsApi.expireOption,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['yield-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-performance'] });
    },
  });

  const assignMutation = useMutation({
    mutationFn: transactionsApi.assignOption,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['yield-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-performance'] });
    },
  });

  const mutationBusy =
    rollMutation.isPending || closeMutation.isPending || expireMutation.isPending || assignMutation.isPending;

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

  const formatQuantity = (value: number) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);

  // Underlying-equivalent share counts are a synthetic exposure measure, so the
  // Positions view rounds them to whole shares (e.g. 49.66 -> 50).
  const formatEquivQuantity = (value: number) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);

  const formatDate = (date: string | null) => formatDateOnly(date);

  const formatPercent = (value: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  const rollDeltaPreview =
    rollDialog != null
      ? calculateExactCost(rollDialog.form.quantity, rollDialog.form.rollCost)
      : null;
  const closeCostPreview =
    closeDialog != null ? calculateExactCost(closeDialog.form.quantity, closeDialog.form.cost) : null;
  const assignPreview =
    assignDialog != null && assignDialog.position.strike_price != null
      ? (() => {
          const optionType = normalizeOptionType(assignDialog.position.option_type);
          const stockQuantity =
            optionType === 'C' ? -Math.abs(assignDialog.position.quantity) : Math.abs(assignDialog.position.quantity);
          return {
            optionType,
            stockTransactionType: stockQuantity < 0 ? 'Sell' : 'Buy',
            stockQuantity,
            stockCost: stockQuantity * assignDialog.position.strike_price,
          };
        })()
      : null;

	  const groups = useMemo<PositionGroup[]>(() => {
	    const grouped = new Map<string, PositionGroup>();
	    // Exposure aggregates run on conversion-netted positions (a long put + short call at the
	    // same strike/expiry locks a sale, so its covered shares carry no exposure); the display
	    // fields (lots / cost / value) are restored from the ORIGINAL positions below.
	    const exposurePositions = netConversions(positions);

	    for (const pos of exposurePositions) {
	      const { underlying, multiplier } = getLeverage(pos.ticker_symbol);
	      const key = positionsMode ? `underlying:${underlying}` : `${pos.ticker_id}:${pos.ticker_symbol}`;
	      const existing = grouped.get(key);
	      const implication = getOptionStockImplication(pos);
	      const stockQuantity = pos.option_code ? 0 : pos.quantity;
	      // Underlying market price for this lot: the ticker's own price when it IS
	      // the underlying (multiplier 1), otherwise the backend-supplied price of
	      // the ETF's underlying (e.g. MSFT for MSFU).
	      const lotUnderlyingPrice =
	        multiplier === 1 ? pos.current_price : pos.underlying_price ?? null;
	      // Value-equivalent conversion: express a leveraged/inverse ETF holding as
	      // the number of underlying shares carrying the same dollar exposure —
	      // (units × ETF_price × leverage) / underlying_price. Falls back to plain
	      // leverage (count-based) when a price is unavailable.
	      let equivFactor = multiplier;
	      if (
	        positionsMode &&
	        multiplier !== 1 &&
	        pos.current_price != null &&
	        lotUnderlyingPrice != null &&
	        lotUnderlyingPrice > 0
	      ) {
	        equivFactor = (multiplier * pos.current_price) / lotUnderlyingPrice;
	      }
	      const quantityMultiplier = positionsMode ? equivFactor : 1;
	      const adjustedStockQuantity = stockQuantity * quantityMultiplier;
	      const adjustedLikelyBuy = implication.likelyBuy * quantityMultiplier;
	      const adjustedLikelySell = implication.likelySell * quantityMultiplier;
	      const adjustedPotentialIBuy = implication.potentialIBuy * quantityMultiplier;
	      const adjustedPotentialISell = implication.potentialISell * quantityMultiplier;
	      const adjustedUnlikelyBuy = implication.unlikelyBuy * quantityMultiplier;
	      const adjustedUnlikelySell = implication.unlikelySell * quantityMultiplier;
	      const effectiveQty = stockQuantity + implication.likelyBuy - implication.likelySell;
	      const potentialIQty = stockQuantity + implication.potentialIBuy - implication.potentialISell;
	      const potentialIIQty = stockQuantity + implication.likelyBuy + implication.unlikelyBuy;
	      const exposureMultiplier = positionsMode ? multiplier : 1;
	      const effectiveExposure = pos.current_price != null ? pos.current_price * effectiveQty * exposureMultiplier : 0;
	      const potentialIExposure = pos.current_price != null ? pos.current_price * potentialIQty * exposureMultiplier : 0;
	      const potentialIIExposure = pos.current_price != null ? pos.current_price * potentialIIQty * exposureMultiplier : 0;

	      if (existing) {
	        existing.componentMultipliers.set(pos.ticker_symbol, multiplier);
	        // In positions mode the group's price is its shared underlying price;
	        // otherwise it's the ticker's own price. Take the first non-null.
	        if (positionsMode) {
	          if (existing.currentPrice == null && lotUnderlyingPrice != null) {
	            existing.currentPrice = lotUnderlyingPrice;
	          }
	        } else if (existing.currentPrice == null && pos.current_price != null) {
	          existing.currentPrice = pos.current_price;
	        }
	        existing.stockQuantity += adjustedStockQuantity;
	        existing.likelyBuyQuantity += adjustedLikelyBuy;
	        existing.likelySellQuantity += adjustedLikelySell;
	        existing.potentialIBuyQuantity += adjustedPotentialIBuy;
	        existing.potentialISellQuantity += adjustedPotentialISell;
	        existing.unlikelyBuyQuantity += adjustedUnlikelyBuy;
	        existing.unlikelySellQuantity += adjustedUnlikelySell;
	        existing.effectiveExposure += effectiveExposure;
	        existing.potentialIExposure += potentialIExposure;
	        existing.potentialIIExposure += potentialIIExposure;
	        existing.totalCost += pos.total_cost;
	        existing.totalValue += pos.total_value;
	        if (pos.option_code) {
          existing.optionLots += 1;
        }
        existing.lots.push(pos);
        continue;
      }

	      grouped.set(key, {
	        key,
	        tickerSymbol: positionsMode ? underlying : pos.ticker_symbol,
	        underlyingSymbol: positionsMode ? underlying : pos.ticker_symbol,
	        componentMultipliers: new Map([[pos.ticker_symbol, multiplier]]),
	        currentPrice: positionsMode ? lotUnderlyingPrice : pos.current_price,
	        stockQuantity: adjustedStockQuantity,
	        likelyBuyQuantity: adjustedLikelyBuy,
	        likelySellQuantity: adjustedLikelySell,
	        potentialIBuyQuantity: adjustedPotentialIBuy,
	        potentialISellQuantity: adjustedPotentialISell,
	        unlikelyBuyQuantity: adjustedUnlikelyBuy,
	        unlikelySellQuantity: adjustedUnlikelySell,
	        effectiveExposure,
	        potentialIExposure,
	        potentialIIExposure,
	        totalCost: pos.total_cost,
	        totalValue: pos.total_value,
	        optionLots: pos.option_code ? 1 : 0,
        lots: [pos],
      });
	    }

	    // Restore display-only fields (holdings, cost, value) from the ORIGINAL positions —
	    // netting is exposure-only, so the table still shows every lot in full.
	    const displayByKey = new Map<string, { lots: Position[]; totalCost: number; totalValue: number; optionLots: number }>();
	    for (const pos of positions) {
	      const { underlying } = getLeverage(pos.ticker_symbol);
	      const key = positionsMode ? `underlying:${underlying}` : `${pos.ticker_id}:${pos.ticker_symbol}`;
	      let d = displayByKey.get(key);
	      if (!d) {
	        d = { lots: [], totalCost: 0, totalValue: 0, optionLots: 0 };
	        displayByKey.set(key, d);
	      }
	      d.lots.push(pos);
	      d.totalCost += pos.total_cost;
	      d.totalValue += pos.total_value;
	      if (pos.option_code) d.optionLots += 1;
	    }
	    for (const group of grouped.values()) {
	      const d = displayByKey.get(group.key);
	      if (d) {
	        group.lots = d.lots;
	        group.totalCost = d.totalCost;
	        group.totalValue = d.totalValue;
	        group.optionLots = d.optionLots;
	      }
	    }

	    return Array.from(grouped.values()).map((group) => ({
	      ...group,
	      tickerSymbol: positionsMode
	        ? getUnderlyingLabel(group.underlyingSymbol, Array.from(group.componentMultipliers.keys()))
	        : group.tickerSymbol,
	    })).sort((a, b) => {
	      if (positionsMode && Math.abs(b.effectiveExposure) !== Math.abs(a.effectiveExposure)) {
	        return Math.abs(b.effectiveExposure) - Math.abs(a.effectiveExposure);
	      }
	      if (b.totalCost !== a.totalCost) {
	        return b.totalCost - a.totalCost;
	      }
	      return a.tickerSymbol.localeCompare(b.tickerSymbol);
	    });
	  }, [positions, positionsMode]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const openRollDialog = (position: Position) => {
    setCloseDialog(null);
    setExpireDialog(null);
    setAssignDialog(null);
    const newOptionType = normalizeOptionType(position.option_type);
    const newExpirationDate = position.expiration_date ?? todayIsoDate();
    const newStrikePrice = position.strike_price != null ? String(position.strike_price) : '';
    const suggestedOptionCode = buildOptionCode(newExpirationDate, newOptionType, newStrikePrice);
    setRollDialog({
      position,
      error: null,
      form: {
        rollDate: todayIsoDate(),
        quantity: String(Math.abs(position.quantity)),
        rollCost: '0',
        closeFees: '',
        openFees: '',
        newOptionType,
        newStrikePrice,
        newExpirationDate,
        newOptionCode: suggestedOptionCode,
        optionCodeEdited: false,
      },
    });
  };

  const openCloseDialog = (position: Position) => {
    setRollDialog(null);
    setExpireDialog(null);
    setAssignDialog(null);
    const quantity = String(Math.abs(position.quantity));
    setCloseDialog({
      position,
      error: null,
      form: {
        closeDate: todayIsoDate(),
        quantity,
        cost: '0',
        fees: '',
      },
    });
  };

  const openExpireDialog = (position: Position) => {
    setRollDialog(null);
    setCloseDialog(null);
    setAssignDialog(null);
    setExpireDialog({
      position,
      error: null,
    });
  };

  const openAssignDialog = (position: Position) => {
    setRollDialog(null);
    setCloseDialog(null);
    setExpireDialog(null);
    setAssignDialog({
      position,
      error: null,
      form: {
        assignmentDate: todayIsoDate(),
      },
    });
  };

  const updateRollForm = <K extends keyof RollFormState>(field: K, value: RollFormState[K]) => {
    setRollDialog((prev) => {
      if (!prev) {
        return prev;
      }
      const nextForm: RollFormState = { ...prev.form, [field]: value } as RollFormState;
      if (
        (field === 'newOptionType' || field === 'newStrikePrice' || field === 'newExpirationDate') &&
        !nextForm.optionCodeEdited
      ) {
        nextForm.newOptionCode = buildOptionCode(
          nextForm.newExpirationDate,
          nextForm.newOptionType,
          nextForm.newStrikePrice
        );
      }
      if (field === 'newOptionCode') {
        nextForm.optionCodeEdited = true;
      }
      return { ...prev, form: nextForm, error: null };
    });
  };

  const updateCloseForm = <K extends keyof CloseFormState>(
    field: K,
    value: CloseFormState[K]
  ) => {
    setCloseDialog((prev) => {
      if (!prev) {
        return prev;
      }
      const nextForm: CloseFormState = { ...prev.form, [field]: value };
      return { ...prev, form: nextForm, error: null };
    });
  };

  const updateAssignForm = <K extends keyof AssignFormState>(
    field: K,
    value: AssignFormState[K]
  ) => {
    setAssignDialog((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, form: { ...prev.form, [field]: value }, error: null };
    });
  };

  const handleRollSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rollDialog) {
      return;
    }

    const { position, form } = rollDialog;
    if (!position.option_code || !position.opened_date) {
      setRollDialog((prev) =>
        prev ? { ...prev, error: 'Selected lot is missing option code or opened date' } : prev
      );
      return;
    }

    const quantity = Number(form.quantity);
    const rollCostPerShare = Number(form.rollCost);
    const totalRollCostText = calculateExactCost(form.quantity, form.rollCost);
    const rollCost = totalRollCostText != null ? Number(totalRollCostText) : Number.NaN;
    const newStrikePrice = Number(form.newStrikePrice);
    const closeFees = form.closeFees.trim() === '' ? null : Number(form.closeFees);
    const openFees = form.openFees.trim() === '' ? null : Number(form.openFees);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      setRollDialog((prev) => (prev ? { ...prev, error: 'Quantity must be a positive number' } : prev));
      return;
    }
    if (Math.abs(quantity - Math.abs(position.quantity)) > 1e-8) {
      setRollDialog((prev) =>
        prev ? { ...prev, error: 'Only full-lot roll is supported right now' } : prev
      );
      return;
    }
    if (!Number.isFinite(rollCostPerShare) || !Number.isFinite(rollCost)) {
      setRollDialog((prev) =>
        prev ? { ...prev, error: 'Roll cost delta per stock must be a valid number' } : prev
      );
      return;
    }
    if (!Number.isFinite(newStrikePrice)) {
      setRollDialog((prev) =>
        prev ? { ...prev, error: 'New strike price must be a valid number' } : prev
      );
      return;
    }
    if (!form.newExpirationDate) {
      setRollDialog((prev) => (prev ? { ...prev, error: 'New expiration date is required' } : prev));
      return;
    }
    if (!form.newOptionCode.trim()) {
      setRollDialog((prev) => (prev ? { ...prev, error: 'New option code is required' } : prev));
      return;
    }
    if ((closeFees != null && !Number.isFinite(closeFees)) || (openFees != null && !Number.isFinite(openFees))) {
      setRollDialog((prev) => (prev ? { ...prev, error: 'Fees must be valid numbers' } : prev));
      return;
    }

    const payload: RollOptionRequest = {
      account_id: position.account_id,
      ticker_id: position.ticker_id,
      old_option_code: position.option_code,
      old_opened_date: position.opened_date,
      old_option_type: position.option_type,
      old_strike_price: position.strike_price,
      old_expiration_date: position.expiration_date,
      quantity,
      close_fees: closeFees,
      roll_date: form.rollDate,
      new_option_type: form.newOptionType,
      new_strike_price: newStrikePrice,
      new_expiration_date: form.newExpirationDate,
      new_option_code: form.newOptionCode.trim(),
      roll_cost: rollCost,
      open_fees: openFees,
    };

    try {
      await rollMutation.mutateAsync(payload);
      setRollDialog(null);
    } catch (error) {
      setRollDialog((prev) =>
        prev ? { ...prev, error: parseApiError(error, 'Failed to roll option') } : prev
      );
    }
  };

  const handleCloseSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!closeDialog) {
      return;
    }

    const { position, form } = closeDialog;
    if (!position.option_code || !position.opened_date) {
      setCloseDialog((prev) =>
        prev ? { ...prev, error: 'Selected lot is missing option code or opened date' } : prev
      );
      return;
    }

    const quantity = Number(form.quantity);
    const costPerStock = Number(form.cost);
    const totalCloseCostText = calculateExactCost(form.quantity, form.cost);
    const fees = form.fees.trim() === '' ? null : Number(form.fees);
    const maxQuantity = Math.abs(position.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      setCloseDialog((prev) =>
        prev ? { ...prev, error: 'Quantity must be a positive number' } : prev
      );
      return;
    }
    if (Math.abs(quantity - maxQuantity) > 1e-8) {
      setCloseDialog((prev) =>
        prev ? { ...prev, error: 'Only full-lot close is supported right now' } : prev
      );
      return;
    }
    if (!Number.isFinite(costPerStock) || totalCloseCostText == null) {
      setCloseDialog((prev) =>
        prev ? { ...prev, error: 'Close cost / stock must be a valid number' } : prev
      );
      return;
    }
    if (fees != null && !Number.isFinite(fees)) {
      setCloseDialog((prev) => (prev ? { ...prev, error: 'Fees must be a valid number' } : prev));
      return;
    }
    if (!form.closeDate) {
      setCloseDialog((prev) => (prev ? { ...prev, error: 'Close date is required' } : prev));
      return;
    }

    const payload: CloseOptionRequest = {
      account_id: position.account_id,
      ticker_id: position.ticker_id,
      option_code: position.option_code,
      opened_date: position.opened_date,
      option_type: position.option_type,
      strike_price: position.strike_price,
      expiration_date: position.expiration_date,
      quantity,
      original_quantity: position.quantity,
      cost: Number(totalCloseCostText),
      fees,
      close_date: form.closeDate,
    };

    try {
      await closeMutation.mutateAsync(payload);
      setCloseDialog(null);
    } catch (error) {
      setCloseDialog((prev) =>
        prev ? { ...prev, error: parseApiError(error, 'Failed to close option') } : prev
      );
    }
  };

  const handleExpireSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!expireDialog) {
      return;
    }

    const { position } = expireDialog;
    if (!position.option_code || !position.opened_date || !position.expiration_date) {
      setExpireDialog((prev) =>
        prev
          ? { ...prev, error: 'Selected lot is missing option code, opened date, or expiration date' }
          : prev
      );
      return;
    }

    const payload: ExpireOptionRequest = {
      account_id: position.account_id,
      ticker_id: position.ticker_id,
      option_code: position.option_code,
      opened_date: position.opened_date,
      option_type: position.option_type,
      strike_price: position.strike_price,
      expiration_date: position.expiration_date,
      original_quantity: position.quantity,
    };

    try {
      await expireMutation.mutateAsync(payload);
      setExpireDialog(null);
    } catch (error) {
      setExpireDialog((prev) =>
        prev ? { ...prev, error: parseApiError(error, 'Failed to expire option') } : prev
      );
    }
  };

	  const handleAssignSubmit = async (event: FormEvent<HTMLFormElement>) => {
	    event.preventDefault();
	    if (!assignDialog) {
	      return;
	    }

    const { position, form } = assignDialog;
    if (!position.option_code || !position.opened_date) {
      setAssignDialog((prev) =>
        prev ? { ...prev, error: 'Selected lot is missing option code or opened date' } : prev
      );
      return;
    }
    if (position.quantity >= 0) {
      setAssignDialog((prev) =>
        prev ? { ...prev, error: 'Only short option lots can be assigned' } : prev
      );
      return;
    }
    if (position.strike_price == null) {
      setAssignDialog((prev) =>
        prev ? { ...prev, error: 'Selected lot is missing strike price' } : prev
      );
      return;
    }
    if (!form.assignmentDate) {
      setAssignDialog((prev) => (prev ? { ...prev, error: 'Assignment date is required' } : prev));
      return;
    }

    const payload: AssignOptionRequest = {
      account_id: position.account_id,
      ticker_id: position.ticker_id,
      option_code: position.option_code,
      opened_date: position.opened_date,
      option_type: position.option_type,
      strike_price: position.strike_price,
      expiration_date: position.expiration_date,
      original_quantity: position.quantity,
      assignment_date: form.assignmentDate,
    };

    try {
      await assignMutation.mutateAsync(payload);
      setAssignDialog(null);
    } catch (error) {
      setAssignDialog((prev) =>
        prev ? { ...prev, error: parseApiError(error, 'Failed to assign option') } : prev
	      );
	    }
	  };

	  const renderSymbolLabel = (symbol: string, multiplier: number) => (
	    <>
	      {symbol}
	      {multiplier !== 1 ? (
	        <span className={`ml-1 text-xs ${multiplier < 0 ? 'text-red-500' : 'text-blue-500'}`}>
	          ({multiplier > 0 ? '+' : ''}{multiplier}x)
	        </span>
	      ) : null}
	    </>
	  );

	  const renderStockLotsTable = (groupKey: string, lots: Position[]) => {
	    if (lots.length === 0) {
	      return <div className="px-1 py-2 text-sm text-gray-500">No stock lots.</div>;
	    }

	    return (
	      <div className="w-full max-w-full overflow-x-auto rounded border border-gray-200">
	        <table className="w-max min-w-max divide-y divide-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
	          <thead className="bg-gray-100">
	            <tr>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Opened
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Quantity
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Avg Cost
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Current Price
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Total Cost
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Total Value
	              </th>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Account
	              </th>
	            </tr>
	          </thead>
	          <tbody className="divide-y divide-gray-200">
	            {lots.map((pos, index) => (
	              <tr
	                key={`${groupKey}-stock-${pos.account_id}-${pos.ticker_symbol}-${index}`}
	                className="text-sm"
	              >
	                <td className="px-4 py-2 text-gray-600">{formatDate(pos.opened_date)}</td>
	                <td className="px-4 py-2 text-right text-gray-900">{formatQuantity(pos.quantity)}</td>
	                <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(pos.avg_cost)}</td>
	                <td className="px-4 py-2 text-right text-gray-900">
	                  {pos.current_price != null ? formatCurrency(pos.current_price) : '-'}
	                </td>
	                <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(pos.total_cost)}</td>
	                <td
	                  className={`px-4 py-2 text-right ${
	                    pos.total_value < 0 ? 'text-red-600' : 'text-gray-900'
	                  }`}
	                >
	                  {formatCurrency(pos.total_value)}
	                </td>
	                <td className="px-4 py-2 text-gray-600">{pos.account_code}</td>
	              </tr>
	            ))}
	          </tbody>
	        </table>
	      </div>
	    );
	  };

	  const renderOptionLotsTable = (groupKey: string, lots: Position[]) => {
	    if (lots.length === 0) {
	      return <div className="px-1 py-2 text-sm text-gray-500">No option lots.</div>;
	    }

	    return (
	      <div className="w-full max-w-full overflow-x-auto rounded border border-gray-200">
	        <table className="w-max min-w-max divide-y divide-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
	          <thead className="bg-gray-100">
	            <tr>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Instrument
	              </th>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Status
	              </th>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Opened
	              </th>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Expiration
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Quantity
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Likely Buy
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Likely Sell
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Avg Cost
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Current Price
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Total Cost
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Total Value
	              </th>
	              <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                Account
	              </th>
	              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
	                Actions
	              </th>
	            </tr>
	          </thead>
	          <tbody className="divide-y divide-gray-200">
	            {lots.map((pos, index) => {
	              const implication = getOptionStockImplication(pos);
	              const canClose =
	                (pos.status ?? 'open') === 'open' &&
	                !!pos.option_code &&
	                !!pos.opened_date &&
	                Math.abs(pos.quantity) > 1e-8;
	              const canExpire = canClose && !!pos.expiration_date;
	              const canRoll = canClose && pos.quantity < 0;
	              const optionType = normalizeOptionType(pos.option_type);
	              const canAssign = canClose && pos.quantity < 0 && pos.strike_price != null && !!pos.option_type;
	              return (
	                <tr
	                  key={`${groupKey}-option-${pos.account_id}-${pos.option_code}-${index}`}
	                  className="text-sm"
	                >
	                  <td className="px-4 py-2 text-gray-900">{formatInstrument(pos)}</td>
	                  <td className="px-4 py-2 text-gray-600">{pos.status ?? 'open'}</td>
	                  <td className="px-4 py-2 text-gray-600">{formatDate(pos.opened_date)}</td>
	                  <td className="px-4 py-2 text-gray-600">{formatDate(pos.expiration_date)}</td>
	                  <td className="px-4 py-2 text-right text-gray-900">{formatQuantity(pos.quantity)}</td>
	                  <td className="px-4 py-2 text-right text-gray-900">
	                    {formatQuantity(implication.likelyBuy)}
	                  </td>
	                  <td className="px-4 py-2 text-right text-gray-900">
	                    {formatQuantity(implication.likelySell)}
	                  </td>
	                  <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(pos.avg_cost)}</td>
	                  <td className="px-4 py-2 text-right text-gray-900">
	                    {pos.current_price != null ? formatCurrency(pos.current_price) : '-'}
	                  </td>
	                  <td className="px-4 py-2 text-right text-gray-900">{formatCurrency(pos.total_cost)}</td>
	                  <td
	                    className={`px-4 py-2 text-right ${
	                      pos.total_value < 0 ? 'text-red-600' : 'text-gray-900'
	                    }`}
	                  >
	                    {formatCurrency(pos.total_value)}
	                  </td>
	                  <td className="px-4 py-2 text-gray-600">{pos.account_code}</td>
	                  <td className="px-4 py-2 text-right">
	                    {canClose ? (
	                      <div className="flex justify-end gap-2">
	                        <button
	                          type="button"
	                          className="rounded border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
	                          onClick={() => openCloseDialog(pos)}
	                          disabled={mutationBusy}
	                        >
	                          Close
	                        </button>
	                        {canExpire ? (
	                          <button
	                            type="button"
	                            className="rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60"
	                            onClick={() => openExpireDialog(pos)}
	                            disabled={mutationBusy}
	                          >
	                            Expire
	                          </button>
	                        ) : null}
	                        {canRoll ? (
	                          <button
	                            type="button"
	                            className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
	                            onClick={() => openRollDialog(pos)}
	                            disabled={mutationBusy}
	                          >
	                            Roll
	                          </button>
	                        ) : null}
	                        {canAssign ? (
	                          <button
	                            type="button"
	                            className="rounded border border-sky-300 px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-60"
	                            onClick={() => openAssignDialog(pos)}
	                            disabled={mutationBusy}
	                            title={
	                              optionType === 'C'
	                                ? 'Create option assignment and stock sell'
	                                : 'Create option assignment and stock buy'
	                            }
	                          >
	                            Assign
	                          </button>
	                        ) : null}
	                      </div>
	                    ) : (
	                      <span className="text-xs text-gray-400">-</span>
	                    )}
	                  </td>
	                </tr>
	              );
	            })}
	          </tbody>
	        </table>
	      </div>
	    );
	  };

	  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table
          className={
            positionsMode
              ? 'w-full table-fixed divide-y divide-gray-200'
              : 'min-w-full divide-y divide-gray-200'
          }
        >
        <thead className="bg-gray-50">
          <tr>
            <th className="w-16 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Details
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Ticker
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Current Price
            </th>
            {positionsMode ? null : (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Stock Qty
              </th>
            )}
            {positionsMode ? null : (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Likely Buy
              </th>
            )}
            {positionsMode ? null : (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Likely Sell
              </th>
            )}
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Effective Qty
            </th>
            {positionsMode ? (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Potential I Qty
              </th>
            ) : null}
            {positionsMode ? (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Potential II Qty
              </th>
            ) : null}
            {positionsMode ? (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                % of Total
              </th>
            ) : null}
            {positionsMode ? (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Potential I %
              </th>
            ) : null}
            {positionsMode ? (
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Potential II %
              </th>
            ) : null}
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Lots
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Option Lots
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Total Cost
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
              Total Value
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
	          {groups.map((group) => {
	            const isExpanded = expanded.has(group.key);
            const sortedLots = group.lots.slice().sort(sortLotsByOpenedDate);
            const stockLots = sortedLots.filter((lot) => !lot.option_code);
            const optionLots = sortedLots.filter((lot) => !!lot.option_code);
	            const componentMembers = Array.from(group.componentMultipliers.entries())
	              .map(([symbol, multiplier]) => ({ symbol, multiplier }))
	              .sort((a, b) => a.symbol.localeCompare(b.symbol));
	            const tickerLotGroups = componentMembers
	              .map((member) => {
	                const memberLots = sortedLots.filter((lot) => lot.ticker_symbol === member.symbol);
	                return {
	                  ...member,
	                  stockLots: memberLots.filter((lot) => !lot.option_code),
	                  optionLots: memberLots.filter((lot) => !!lot.option_code),
	                };
	              })
	              .filter((member) => member.stockLots.length > 0 || member.optionLots.length > 0);
	            const showComponentMembers =
	              positionsMode &&
	              (componentMembers.length > 1 ||
	                componentMembers.some((member) => member.symbol !== group.tickerSymbol || member.multiplier !== 1));
	            const effectiveQuantity =
	              group.stockQuantity + group.likelyBuyQuantity - group.likelySellQuantity;
            const potentialIQuantity =
              group.stockQuantity + group.potentialIBuyQuantity - group.potentialISellQuantity;
            const potentialIIQuantity = group.stockQuantity + group.likelyBuyQuantity + group.unlikelyBuyQuantity;
            const expandedColSpan = positionsMode ? 13 : 11;
            const hasDenominator =
              percentageDenominator != null &&
              Number.isFinite(percentageDenominator) &&
              Math.abs(percentageDenominator) > 0;
	            const effectivePositionValue =
	              positionsMode
	                ? group.effectiveExposure
	                : group.currentPrice != null
	                  ? group.currentPrice * effectiveQuantity
	                  : null;
	            const positionWeight =
	              hasDenominator && effectivePositionValue != null
	                ? effectivePositionValue / percentageDenominator
	                : null;
	            const potentialIPositionValue =
	              positionsMode
	                ? group.potentialIExposure
	                : group.currentPrice != null
	                  ? group.currentPrice * potentialIQuantity
	                  : null;
	            const potentialIPositionWeight =
	              hasDenominator && potentialIPositionValue != null
	                ? potentialIPositionValue / percentageDenominator
	                : null;
	            const potentialIIPositionValue =
	              positionsMode
	                ? group.potentialIIExposure
	                : group.currentPrice != null
	                  ? group.currentPrice * potentialIIQuantity
	                  : null;
            const potentialIIPositionWeight =
              hasDenominator && potentialIIPositionValue != null
                ? potentialIIPositionValue / percentageDenominator
                : null;
            return (
              <Fragment key={group.key}>
                <tr key={group.key} className="hover:bg-gray-50">
                  <td className="px-4 py-4 whitespace-nowrap text-sm">
                    <button
                      type="button"
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                      onClick={() => toggleExpanded(group.key)}
                    >
                      {isExpanded ? 'Hide' : 'Show'}
                    </button>
                  </td>
	                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
	                    <div>{group.tickerSymbol}</div>
	                    {showComponentMembers ? (
	                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs font-normal text-gray-500">
	                        {componentMembers.map((member) => (
	                          <span key={member.symbol}>
	                            {member.symbol}
	                            {member.multiplier !== 1 ? (
	                              <span className={member.multiplier < 0 ? 'text-red-500' : 'text-blue-500'}>
	                                {' '}({member.multiplier > 0 ? '+' : ''}{member.multiplier}x)
	                              </span>
	                            ) : null}
	                          </span>
	                        ))}
	                      </div>
	                    ) : null}
	                  </td>
	                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
	                    {group.currentPrice != null ? formatCurrency(group.currentPrice) : componentMembers.length > 1 ? 'Mixed' : '-'}
	                  </td>
                  {positionsMode ? null : (
                    <td
                      className={`px-6 py-4 whitespace-nowrap text-right text-sm ${
                        group.stockQuantity < 0 ? 'text-red-600' : 'text-gray-900'
                      }`}
                    >
                      {formatQuantity(group.stockQuantity)}
                    </td>
                  )}
                  {positionsMode ? null : (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                      {formatQuantity(group.likelyBuyQuantity)}
                    </td>
                  )}
                  {positionsMode ? null : (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                      {formatQuantity(group.likelySellQuantity)}
                    </td>
                  )}
                  <td
                    className={`px-6 py-4 whitespace-nowrap text-right text-sm ${
                      effectiveQuantity < 0 ? 'text-red-600' : 'text-gray-900'
                    }`}
                  >
                    {positionsMode ? formatEquivQuantity(effectiveQuantity) : formatQuantity(effectiveQuantity)}
                  </td>
                  {positionsMode ? (
                    <td
                      className={`px-6 py-4 whitespace-nowrap text-right text-sm ${
                        potentialIQuantity < 0 ? 'text-red-600' : 'text-gray-900'
                      }`}
                    >
                      {formatEquivQuantity(potentialIQuantity)}
                    </td>
                  ) : null}
                  {positionsMode ? (
                    <td
                      className={`px-6 py-4 whitespace-nowrap text-right text-sm ${
                        potentialIIQuantity < 0 ? 'text-red-600' : 'text-gray-900'
                      }`}
                    >
                      {formatEquivQuantity(potentialIIQuantity)}
                    </td>
                  ) : null}
                  {positionsMode ? (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                      {positionWeight != null ? formatPercent(positionWeight) : '-'}
                    </td>
                  ) : null}
                  {positionsMode ? (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                      {potentialIPositionWeight != null ? formatPercent(potentialIPositionWeight) : '-'}
                    </td>
                  ) : null}
                  {positionsMode ? (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                      {potentialIIPositionWeight != null ? formatPercent(potentialIIPositionWeight) : '-'}
                    </td>
                  ) : null}
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                    {group.lots.length}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                    {group.optionLots}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                    {formatCurrency(group.totalCost)}
                  </td>
                  <td
                    className={`px-6 py-4 whitespace-nowrap text-right text-sm ${
                      group.totalValue < 0 ? 'text-red-600' : 'text-gray-900'
                    }`}
                  >
                    {formatCurrency(group.totalValue)}
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="bg-gray-50">
                    <td className="px-4 py-3 align-top" colSpan={expandedColSpan}>
	                      {positionsMode ? (
	                        <div className="w-full min-w-0 space-y-4 rounded border border-gray-200 bg-white p-3">
	                          {tickerLotGroups.map((tickerGroup) => (
	                            <div
	                              key={`${group.key}-${tickerGroup.symbol}`}
	                              className="space-y-3 rounded border border-gray-200 bg-gray-50 p-3"
	                            >
	                              <div className="px-1 text-sm font-semibold text-gray-900">
	                                {renderSymbolLabel(tickerGroup.symbol, tickerGroup.multiplier)}
	                              </div>
	                              <div>
	                                <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
	                                  {tickerGroup.symbol} Stock Lots
	                                </div>
	                                {renderStockLotsTable(group.key, tickerGroup.stockLots)}
	                              </div>
	                              <div>
	                                <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
	                                  {tickerGroup.symbol} Option Lots
	                                </div>
	                                {renderOptionLotsTable(group.key, tickerGroup.optionLots)}
	                              </div>
	                            </div>
	                          ))}
	                          <div className="hidden">
	                            <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
	                              Stock Lots
	                            </div>
                            {stockLots.length > 0 ? (
                              <div className="w-full max-w-full overflow-x-auto rounded border border-gray-200">
                                <table className="w-max min-w-max divide-y divide-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
	                                  <thead className="bg-gray-100">
	                                    <tr>
	                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                                        Symbol
	                                      </th>
	                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                                        Opened
	                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Quantity
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Avg Cost
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Current Price
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Total Cost
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Total Value
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Account
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-200">
	                                    {stockLots.map((pos, index) => {
	                                      const lotLeverage = getLeverage(pos.ticker_symbol);
	                                      return (
	                                        <tr
	                                          key={`${group.key}-stock-${pos.account_id}-${pos.ticker_symbol}-${index}`}
	                                          className="text-sm"
	                                        >
	                                          <td className="px-4 py-2 font-medium text-gray-900">
	                                            {pos.ticker_symbol}
	                                            {lotLeverage.multiplier !== 1 ? (
	                                              <span className={`ml-1 text-xs ${lotLeverage.multiplier < 0 ? 'text-red-500' : 'text-blue-500'}`}>
	                                                ({lotLeverage.multiplier > 0 ? '+' : ''}{lotLeverage.multiplier}x)
	                                              </span>
	                                            ) : null}
	                                          </td>
	                                          <td className="px-4 py-2 text-gray-600">{formatDate(pos.opened_date)}</td>
	                                          <td className="px-4 py-2 text-right text-gray-900">
	                                            {formatQuantity(pos.quantity)}
	                                          </td>
	                                          <td className="px-4 py-2 text-right text-gray-900">
	                                            {formatCurrency(pos.avg_cost)}
	                                          </td>
	                                          <td className="px-4 py-2 text-right text-gray-900">
	                                            {pos.current_price != null ? formatCurrency(pos.current_price) : '-'}
	                                          </td>
	                                          <td className="px-4 py-2 text-right text-gray-900">
	                                            {formatCurrency(pos.total_cost)}
	                                          </td>
	                                          <td
	                                            className={`px-4 py-2 text-right ${
	                                              pos.total_value < 0 ? 'text-red-600' : 'text-gray-900'
	                                            }`}
	                                          >
	                                            {formatCurrency(pos.total_value)}
	                                          </td>
	                                          <td className="px-4 py-2 text-gray-600">{pos.account_code}</td>
	                                        </tr>
	                                      );
	                                    })}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="px-1 py-2 text-sm text-gray-500">No stock lots.</div>
                            )}
                          </div>

	                          <div className="hidden">
	                            <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
	                              Option Lots
	                            </div>
                            {optionLots.length > 0 ? (
                              <div className="w-full max-w-full overflow-x-auto rounded border border-gray-200">
                                <table className="w-max min-w-max divide-y divide-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
	                                  <thead className="bg-gray-100">
	                                    <tr>
	                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                                        Symbol
	                                      </th>
	                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
	                                        Instrument
	                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Status
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Opened
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Expiration
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Quantity
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Likely Buy
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Likely Sell
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Avg Cost
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Current Price
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Total Cost
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Total Value
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Account
                                      </th>
                                      <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                        Actions
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-200">
	                                    {optionLots.map((pos, index) => {
	                                      const implication = getOptionStockImplication(pos);
	                                      const lotLeverage = getLeverage(pos.ticker_symbol);
	                                      const canClose =
	                                        (pos.status ?? 'open') === 'open' &&
                                        !!pos.option_code &&
                                        !!pos.opened_date &&
                                        Math.abs(pos.quantity) > 1e-8;
                                      const canExpire = canClose && !!pos.expiration_date;
                                      const canRoll = canClose && pos.quantity < 0;
                                      const optionType = normalizeOptionType(pos.option_type);
                                      const canAssign =
                                        canClose && pos.quantity < 0 && pos.strike_price != null && !!pos.option_type;
                                      return (
                                        <tr
	                                          key={`${group.key}-option-${pos.account_id}-${pos.option_code}-${index}`}
	                                          className="text-sm"
	                                        >
	                                          <td className="px-4 py-2 font-medium text-gray-900">
	                                            {pos.ticker_symbol}
	                                            {lotLeverage.multiplier !== 1 ? (
	                                              <span className={`ml-1 text-xs ${lotLeverage.multiplier < 0 ? 'text-red-500' : 'text-blue-500'}`}>
	                                                ({lotLeverage.multiplier > 0 ? '+' : ''}{lotLeverage.multiplier}x)
	                                              </span>
	                                            ) : null}
	                                          </td>
	                                          <td className="px-4 py-2 text-gray-900">{formatInstrument(pos)}</td>
                                          <td className="px-4 py-2 text-gray-600">{pos.status ?? 'open'}</td>
                                          <td className="px-4 py-2 text-gray-600">{formatDate(pos.opened_date)}</td>
                                          <td className="px-4 py-2 text-gray-600">
                                            {formatDate(pos.expiration_date)}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {formatQuantity(pos.quantity)}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {formatQuantity(implication.likelyBuy)}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {formatQuantity(implication.likelySell)}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {formatCurrency(pos.avg_cost)}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {pos.current_price != null ? formatCurrency(pos.current_price) : '-'}
                                          </td>
                                          <td className="px-4 py-2 text-right text-gray-900">
                                            {formatCurrency(pos.total_cost)}
                                          </td>
                                          <td
                                            className={`px-4 py-2 text-right ${
                                              pos.total_value < 0 ? 'text-red-600' : 'text-gray-900'
                                            }`}
                                          >
                                            {formatCurrency(pos.total_value)}
                                          </td>
                                          <td className="px-4 py-2 text-gray-600">{pos.account_code}</td>
                                          <td className="px-4 py-2 text-right">
                                            {canClose ? (
                                              <div className="flex justify-end gap-2">
                                                <button
                                                  type="button"
                                                  className="rounded border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                                                  onClick={() => openCloseDialog(pos)}
                                                  disabled={mutationBusy}
                                                >
                                                  Close
                                                </button>
                                                {canExpire ? (
                                                  <button
                                                    type="button"
                                                    className="rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                                                    onClick={() => openExpireDialog(pos)}
                                                    disabled={mutationBusy}
                                                  >
                                                    Expire
                                                  </button>
                                                ) : null}
                                                {canRoll ? (
                                                  <button
                                                    type="button"
                                                    className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                                                    onClick={() => openRollDialog(pos)}
                                                    disabled={mutationBusy}
                                                  >
                                                    Roll
                                                  </button>
                                                ) : null}
                                                {canAssign ? (
                                                  <button
                                                    type="button"
                                                    className="rounded border border-sky-300 px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-60"
                                                    onClick={() => openAssignDialog(pos)}
                                                    disabled={mutationBusy}
                                                    title={
                                                      optionType === 'C'
                                                        ? 'Create option assignment and stock sell'
                                                        : 'Create option assignment and stock buy'
                                                    }
                                                  >
                                                    Assign
                                                  </button>
                                                ) : null}
                                              </div>
                                            ) : (
                                              <span className="text-xs text-gray-400">-</span>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="px-1 py-2 text-sm text-gray-500">No option lots.</div>
                            )}
                          </div>

	                          {(() => {
	                            const realizedTickerIds = new Set(group.lots.map((lot) => lot.ticker_id));
	                            const rz = Array.from(realizedTickerIds).reduce<RealizedPnlBreakdown>(
	                              (sum, tickerId) => {
	                                const item = realizedPnlByTicker?.get(tickerId);
	                                if (!item) {
	                                  return sum;
	                                }
	                                return {
	                                  stock: sum.stock + item.stock,
	                                  option: sum.option + item.option,
	                                };
	                              },
	                              { stock: 0, option: 0 },
	                            );
	                            let unrealizedStock = 0;
                            let unrealizedOption = 0;
                            for (const pos of group.lots) {
                              if (pos.current_price == null) continue;
                              if (!pos.option_code) {
                                // total_value is overwritten to market value by backend enrichment,
                                // so use avg_cost * quantity as cost basis instead
                                unrealizedStock += (pos.current_price - pos.avg_cost) * pos.quantity;
                              } else if (pos.strike_price != null) {
                                const intrinsic = pos.option_type === 'C'
                                  ? Math.max(0, pos.current_price - pos.strike_price)
                                  : Math.max(0, pos.strike_price - pos.current_price);
                                unrealizedOption += intrinsic * pos.quantity - pos.total_value;
                              }
                            }
                            const total = rz.stock + rz.option + unrealizedStock + unrealizedOption;
                            const pnlColor = (v: number) => v < -0.005 ? 'text-red-600' : v > 0.005 ? 'text-green-600' : 'text-gray-900';
                            return (
                              <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                                  Profit &amp; Loss
                                </div>
                                <div className="grid grid-cols-3 gap-x-8 gap-y-1 text-sm">
                                  <div />
                                  <div className="text-xs font-medium text-gray-400">Stock</div>
                                  <div className="text-xs font-medium text-gray-400">Options</div>

                                  <div className="text-gray-500">Realized</div>
                                  <div className={pnlColor(rz.stock)}>{formatCurrency(rz.stock)}</div>
                                  <div className={pnlColor(rz.option)}>{formatCurrency(rz.option)}</div>

                                  <div className="text-gray-500">Unrealized</div>
                                  <div className={pnlColor(unrealizedStock)}>{formatCurrency(unrealizedStock)}</div>
                                  <div className={pnlColor(unrealizedOption)}>{formatCurrency(unrealizedOption)}</div>

                                  <div className="text-gray-500 font-semibold pt-1 border-t border-gray-200">Total</div>
                                  <div className={`font-semibold pt-1 border-t border-gray-200 ${pnlColor(rz.stock + unrealizedStock)}`}>
                                    {formatCurrency(rz.stock + unrealizedStock)}
                                  </div>
                                  <div className={`font-semibold pt-1 border-t border-gray-200 ${pnlColor(rz.option + unrealizedOption)}`}>
                                    {formatCurrency(rz.option + unrealizedOption)}
                                  </div>
                                </div>
                                <div className={`mt-2 text-sm font-semibold ${pnlColor(total)}`}>
                                  Grand Total: {formatCurrency(total)}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div className="w-full max-w-full overflow-x-auto rounded border border-gray-200 bg-white">
                          <table className="w-max min-w-max divide-y divide-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
                            <thead className="bg-gray-100">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Instrument
                                </th>
                                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Status
                                </th>
                                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Opened
                                </th>
                                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Expiration
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Quantity
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Likely Buy
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Likely Sell
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Avg Cost
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Current Price
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Total Cost
                                </th>
                                <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Total Value
                                </th>
                                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                                  Account
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                              {sortedLots.map((pos, index) => {
                                const implication = getOptionStockImplication(pos);
                                return (
                                  <tr
                                    key={`${group.key}-${pos.account_id}-${pos.option_code || 'stock'}-${index}`}
                                    className="text-sm"
                                  >
                                    <td className="px-4 py-2 text-gray-900">{formatInstrument(pos)}</td>
                                    <td className="px-4 py-2 text-gray-600">{pos.status ?? 'open'}</td>
                                    <td className="px-4 py-2 text-gray-600">{formatDate(pos.opened_date)}</td>
                                    <td className="px-4 py-2 text-gray-600">{formatDate(pos.expiration_date)}</td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {formatQuantity(pos.quantity)}
                                    </td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {formatQuantity(implication.likelyBuy)}
                                    </td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {formatQuantity(implication.likelySell)}
                                    </td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {formatCurrency(pos.avg_cost)}
                                    </td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {pos.current_price != null ? formatCurrency(pos.current_price) : '-'}
                                    </td>
                                    <td className="px-4 py-2 text-right text-gray-900">
                                      {formatCurrency(pos.total_cost)}
                                    </td>
                                    <td
                                      className={`px-4 py-2 text-right ${
                                        pos.total_value < 0 ? 'text-red-600' : 'text-gray-900'
                                      }`}
                                    >
                                      {formatCurrency(pos.total_value)}
                                    </td>
                                    <td className="px-4 py-2 text-gray-600">{pos.account_code}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          </tbody>
        </table>
      </div>

      {positionsMode && rollDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h4 className="text-base font-semibold text-gray-900">Roll Option Position</h4>
                <p className="mt-1 text-xs text-gray-500">
                  {rollDialog.position.account_code} · {rollDialog.position.ticker_symbol} ·{' '}
                  {rollDialog.position.option_code}
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => setRollDialog(null)}
                disabled={mutationBusy}
              >
                Close
              </button>
            </div>

            <form className="space-y-4 px-5 py-4" onSubmit={handleRollSubmit}>
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                This action will close the existing open lot and create two new transactions:
                `Extended` (closed) + `Sell extended` (open).
                `Extended` keeps the original lot price from history.
                `Sell extended` uses that price shifted by the roll delta.
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="text-sm text-gray-700">
                  Roll Date
                  <input
                    type="date"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.rollDate}
                    onChange={(e) => updateRollForm('rollDate', e.target.value)}
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  Quantity
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.quantity}
                    onChange={(e) => updateRollForm('quantity', e.target.value)}
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  Close Fees
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.closeFees}
                    onChange={(e) => updateRollForm('closeFees', e.target.value)}
                    placeholder="Optional"
                  />
                </label>
                <label className="text-sm text-gray-700">
                  New Option Type
                  <select
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.newOptionType}
                    onChange={(e) => updateRollForm('newOptionType', e.target.value as 'C' | 'P')}
                  >
                    <option value="C">Call</option>
                    <option value="P">Put</option>
                  </select>
                </label>

                <label className="text-sm text-gray-700">
                  New Expiration
                  <input
                    type="date"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.newExpirationDate}
                    onChange={(e) => updateRollForm('newExpirationDate', e.target.value)}
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  New Strike
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.newStrikePrice}
                    onChange={(e) => updateRollForm('newStrikePrice', e.target.value)}
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  New Option Code
                  <input
                    type="text"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.newOptionCode}
                    onChange={(e) => updateRollForm('newOptionCode', e.target.value)}
                    required
                  />
                </label>

                <label className="text-sm text-gray-700">
                  Roll Cost Delta / Stock
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.rollCost}
                    onChange={(e) => updateRollForm('rollCost', e.target.value)}
                    required
                  />
                  <div className="mt-1 text-xs text-gray-500">
                    Negative for net credit, positive for net debit.
                    The backend applies this delta to the inherited option price.
                    {rollDeltaPreview != null ? ` Preview total: ${formatCurrency(Number(rollDeltaPreview))}.` : ''}
                  </div>
                </label>
                <label className="text-sm text-gray-700">
                  Open Fees
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={rollDialog.form.openFees}
                    onChange={(e) => updateRollForm('openFees', e.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </div>

              {rollDialog.error ? (
                <div className="text-sm font-medium text-red-600">{rollDialog.error}</div>
              ) : null}

              <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setRollDialog(null)}
                  disabled={mutationBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                  disabled={mutationBusy}
                >
                  {rollMutation.isPending ? 'Rolling...' : 'Create Roll Transactions'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {positionsMode && closeDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h4 className="text-base font-semibold text-gray-900">Close Option Position</h4>
                <p className="mt-1 text-xs text-gray-500">
                  {closeDialog.position.account_code} · {closeDialog.position.ticker_symbol} ·{' '}
                  {closeDialog.position.option_code}
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => setCloseDialog(null)}
                disabled={mutationBusy}
              >
                Close
              </button>
            </div>

            <form className="space-y-4 px-5 py-4" onSubmit={handleCloseSubmit}>
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                This action will mark the selected open lot as closed and create one closing
                transaction. Full-lot close only.
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="text-sm text-gray-700">
                  Close Date
                  <input
                    type="date"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={closeDialog.form.closeDate}
                    onChange={(e) => updateCloseForm('closeDate', e.target.value)}
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  Quantity
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="mt-1 block w-full rounded-md border-gray-300 bg-gray-100 text-sm shadow-sm"
                    value={closeDialog.form.quantity}
                    readOnly
                    required
                  />
                </label>
                <label className="text-sm text-gray-700">
                  Close Cost / Stock
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={closeDialog.form.cost}
                    onChange={(e) => updateCloseForm('cost', e.target.value)}
                    required
                  />
                  <div className="mt-1 text-xs text-gray-500">
                    {closeDialog.position.quantity < 0
                      ? 'Positive for buy-to-cover debit.'
                      : 'Negative for sell credit.'}
                    The saved transaction price is derived from this option close cost, not the current stock price.
                    Total cost written to history is per-stock cost × quantity.
                    {closeCostPreview != null
                      ? ` Preview total: ${formatCurrency(Number(closeCostPreview))}.`
                      : ''}
                  </div>
                </label>
                <label className="text-sm text-gray-700 md:col-span-2">
                  Fees
                  <input
                    type="number"
                    step="any"
                    className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                    value={closeDialog.form.fees}
                    onChange={(e) => updateCloseForm('fees', e.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </div>

              {closeDialog.error ? (
                <div className="text-sm font-medium text-red-600">{closeDialog.error}</div>
              ) : null}

              <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setCloseDialog(null)}
                  disabled={mutationBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
                  disabled={mutationBusy}
                >
                  {closeMutation.isPending ? 'Closing...' : 'Close Option'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {positionsMode && expireDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h4 className="text-base font-semibold text-gray-900">Expire Option Position</h4>
                <p className="mt-1 text-xs text-gray-500">
                  {expireDialog.position.account_code} · {expireDialog.position.ticker_symbol} ·{' '}
                  {expireDialog.position.option_code}
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => setExpireDialog(null)}
                disabled={mutationBusy}
              >
                Close
              </button>
            </div>

            <form className="space-y-4 px-5 py-4" onSubmit={handleExpireSubmit}>
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                This will mark the selected open lot as closed and create one `Expired`
                transaction dated {formatDate(expireDialog.position.expiration_date)}.
              </div>

              <dl className="grid grid-cols-1 gap-3 text-sm text-gray-700 md:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">
                    Quantity
                  </dt>
                  <dd className="mt-1">{formatQuantity(Math.abs(expireDialog.position.quantity))}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">
                    Expiration Date
                  </dt>
                  <dd className="mt-1">{formatDate(expireDialog.position.expiration_date)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">
                    Instrument
                  </dt>
                  <dd className="mt-1">{formatInstrument(expireDialog.position)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">
                    Recorded Price
                  </dt>
                  <dd className="mt-1">$0.00</dd>
                </div>
              </dl>

              {expireDialog.error ? (
                <div className="text-sm font-medium text-red-600">{expireDialog.error}</div>
              ) : null}

              <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setExpireDialog(null)}
                  disabled={mutationBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                  disabled={mutationBusy}
                >
                  {expireMutation.isPending ? 'Expiring...' : 'Expire Option'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {positionsMode && assignDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h4 className="text-base font-semibold text-gray-900">Assign Option Position</h4>
                <p className="mt-1 text-xs text-gray-500">
                  {assignDialog.position.account_code} · {assignDialog.position.ticker_symbol} ·{' '}
                  {assignDialog.position.option_code}
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => setAssignDialog(null)}
                disabled={mutationBusy}
              >
                Close
              </button>
            </div>

            <form className="space-y-4 px-5 py-4" onSubmit={handleAssignSubmit}>
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                This will close the selected option lot with one zero-cost `Assigned` transaction and create
                one stock {assignPreview?.stockTransactionType ?? 'Buy/Sell'} order at the strike price.
              </div>

              <label className="block text-sm text-gray-700">
                Assignment Date
                <input
                  type="date"
                  className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm"
                  value={assignDialog.form.assignmentDate}
                  onChange={(e) => updateAssignForm('assignmentDate', e.target.value)}
                  required
                />
              </label>

              <dl className="grid grid-cols-1 gap-3 text-sm text-gray-700 md:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">Option Close Qty</dt>
                  <dd className="mt-1">{formatQuantity(Math.abs(assignDialog.position.quantity))}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">Strike Price</dt>
                  <dd className="mt-1">
                    {assignDialog.position.strike_price != null
                      ? formatCurrency(assignDialog.position.strike_price)
                      : '-'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">Option Transaction</dt>
                  <dd className="mt-1">Assigned · {formatCurrency(0)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-gray-500">Stock Transaction</dt>
                  <dd className="mt-1">
                    {assignPreview
                      ? `${assignPreview.stockTransactionType} ${formatQuantity(assignPreview.stockQuantity)} · ${formatCurrency(assignPreview.stockCost)}`
                      : '-'}
                  </dd>
                </div>
              </dl>

              {assignDialog.error ? (
                <div className="text-sm font-medium text-red-600">{assignDialog.error}</div>
              ) : null}

              <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setAssignDialog(null)}
                  disabled={mutationBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
                  disabled={mutationBusy}
                >
                  {assignMutation.isPending ? 'Assigning...' : 'Assign Option'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
