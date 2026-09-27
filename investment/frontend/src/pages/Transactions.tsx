import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountsApi, tickersApi, transactionsApi } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import type {
  Account,
  CreateTransactionRequest,
  Ticker,
  TransactionFilter,
  TransactionWithDetails,
  UpdateTransactionRequest,
} from '../api/types';
import { formatLocalDateInputValue } from '../utils/date';

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];
const EMPTY_TRANSACTIONS: TransactionWithDetails[] = [];
const TRANSACTION_TYPES = [
  'Buy',
  'Sell',
  'Sell short',
  'Sell to short',
  'Buy to cover',
  'Buy to close',
  'Buy spread',
  'Assigned',
  'Early Assigned',
  'Extended',
  'Sell extended',
  'Unextended',
  'Sell unextended',
  'Reverse extended',
  'Deposit',
  'Withdraw',
  'Dividend',
  'Expire',
  'Expired',
  'Split',
  'Reverse Split',
  'Reverse split',
];
const DEFAULT_STATUS = 'open';

interface TransactionFormState {
  account_id: string;
  ticker_symbol: string;
  transaction_type: string;
  quantity: string;
  price: string;
  cost: string;
  fees: string;
  date: string;
  status: string;
  option_type: string;
  strike_price: string;
  expiration_date: string;
  option_code: string;
}

interface NormalizedTransactionForm {
  account_id: number;
  symbol: string;
  transaction_type: string;
  quantity: number;
  price: number;
  cost: number;
  fees: number | null;
  date: string;
  status: string | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_code: string | null;
}

interface EditTransactionState {
  transactionId: number;
  transactionLabel: string;
  form: TransactionFormState;
  error: string | null;
}

interface ParsedOptionCode {
  optionType: 'C' | 'P';
  strikePrice: string;
  expirationDate: string;
}

interface ParsedDecimal {
  sign: bigint;
  digits: bigint;
  scale: number;
}

function getDefaultTransactionForm(): TransactionFormState {
  return {
    account_id: '',
    ticker_symbol: '',
    transaction_type: 'Buy',
    quantity: '',
    price: '',
    cost: '',
    fees: '',
    date: formatLocalDateInputValue(),
    status: DEFAULT_STATUS,
    option_type: '',
    strike_price: '',
    expiration_date: '',
    option_code: '',
  };
}

function parseApiError(error: unknown, fallback: string): string {
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

function normalizeTransactionForm(
  form: TransactionFormState
): { payload: NormalizedTransactionForm | null; error: string | null } {
  const accountId = Number(form.account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { payload: null, error: 'Account is required' };
  }

  const symbol = form.ticker_symbol.trim().toUpperCase();
  if (!symbol) {
    return { payload: null, error: 'Ticker symbol is required' };
  }

  const quantity = Number(form.quantity);
  const price = Number(form.price);
  const cost = Number(form.cost);
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(cost)) {
    return { payload: null, error: 'Quantity, price, and cost must be valid numbers' };
  }

  if (!form.date) {
    return { payload: null, error: 'Date is required' };
  }

  const fees = form.fees.trim() === '' ? null : Number(form.fees);
  if (fees != null && !Number.isFinite(fees)) {
    return { payload: null, error: 'Fees must be a valid number' };
  }

  const strikePrice = form.strike_price.trim() === '' ? null : Number(form.strike_price);
  if (strikePrice != null && !Number.isFinite(strikePrice)) {
    return { payload: null, error: 'Strike price must be a valid number' };
  }

  return {
    payload: {
      account_id: accountId,
      symbol,
      transaction_type: form.transaction_type,
      quantity,
      price,
      cost,
      fees,
      date: form.date,
      status: form.status || DEFAULT_STATUS,
      option_type: form.option_type.trim().toUpperCase() || null,
      strike_price: strikePrice,
      expiration_date: form.expiration_date || null,
      option_code: form.option_code.trim() || null,
    },
    error: null,
  };
}

function transactionToForm(
  transaction: TransactionWithDetails,
  accountIdByCode: Map<string, number>
): TransactionFormState {
  return {
    account_id: accountIdByCode.get(transaction.account_code)?.toString() ?? '',
    ticker_symbol: transaction.ticker_symbol,
    transaction_type: transaction.transaction_type,
    quantity: transaction.quantity.toString(),
    price: transaction.price.toString(),
    cost: transaction.cost.toString(),
    fees: transaction.fees != null ? transaction.fees.toString() : '',
    date: transaction.date,
    status: transaction.status ?? DEFAULT_STATUS,
    option_type: transaction.option_type ?? '',
    strike_price: transaction.strike_price != null ? transaction.strike_price.toString() : '',
    expiration_date: transaction.expiration_date ?? '',
    option_code: transaction.option_code ?? '',
  };
}

function parseOptionCode(optionCode: string): ParsedOptionCode | null {
  const trimmed = optionCode.trim().toUpperCase();
  const match = trimmed.match(/^(?:[A-Z]+)?(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const [, yy, mm, dd, optionType, strikePrice] = match;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const parsedDate = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    return null;
  }

  return {
    optionType: optionType as 'C' | 'P',
    strikePrice,
    expirationDate: `${year}-${mm}-${dd}`,
  };
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

function applyOptionCodeDerivedFields(
  form: TransactionFormState,
  field: keyof TransactionFormState
): TransactionFormState {
  const next = { ...form };
  const parsed = parseOptionCode(next.option_code);

  if (parsed && field === 'option_code') {
    next.option_type = parsed.optionType;
    next.strike_price = parsed.strikePrice;
    next.expiration_date = parsed.expirationDate;
  }

  if (parsed && (field === 'option_code' || field === 'quantity' || field === 'price')) {
    const cost = calculateExactCost(next.quantity, next.price);
    if (cost != null) {
      next.cost = cost;
    }
  }

  return next;
}

interface TransactionFormFieldsProps {
  accounts: Account[];
  tickers: Ticker[];
  transactionTypes: string[];
  form: TransactionFormState;
  symbolOptionsId: string;
  onFieldChange: (field: keyof TransactionFormState, value: string) => void;
  onAutoCost: () => void;
}

function TransactionFormFields({
  accounts,
  tickers,
  transactionTypes,
  form,
  symbolOptionsId,
  onFieldChange,
  onAutoCost,
}: TransactionFormFieldsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <label className="text-sm text-gray-700">
        Account
        <select
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.account_id}
          onChange={(e) => onFieldChange('account_id', e.target.value)}
          required
        >
          <option value="">Select account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code}
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm text-gray-700">
        Symbol
        <input
          type="text"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.ticker_symbol}
          onChange={(e) => onFieldChange('ticker_symbol', e.target.value.toUpperCase())}
          placeholder="AAPL"
          list={symbolOptionsId}
          required
        />
        <datalist id={symbolOptionsId}>
          {tickers.map((ticker) => (
            <option key={ticker.id} value={ticker.symbol} />
          ))}
        </datalist>
      </label>

      <label className="text-sm text-gray-700">
        Type
        <select
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.transaction_type}
          onChange={(e) => onFieldChange('transaction_type', e.target.value)}
          required
        >
          {transactionTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm text-gray-700">
        Date
        <input
          type="date"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.date}
          onChange={(e) => onFieldChange('date', e.target.value)}
          required
        />
      </label>

      <label className="text-sm text-gray-700">
        Quantity
        <input
          type="number"
          step="any"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.quantity}
          onChange={(e) => onFieldChange('quantity', e.target.value)}
          required
        />
      </label>

      <label className="text-sm text-gray-700">
        Price
        <input
          type="number"
          step="any"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.price}
          onChange={(e) => onFieldChange('price', e.target.value)}
          required
        />
      </label>

      <label className="text-sm text-gray-700">
        Cost
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            step="any"
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={form.cost}
            onChange={(e) => onFieldChange('cost', e.target.value)}
            required
          />
          <button
            type="button"
            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            onClick={onAutoCost}
          >
            Auto
          </button>
        </div>
      </label>

      <label className="text-sm text-gray-700">
        Fees
        <input
          type="number"
          step="any"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.fees}
          onChange={(e) => onFieldChange('fees', e.target.value)}
          placeholder="Optional"
        />
      </label>

      <label className="text-sm text-gray-700">
        Status
        <select
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.status}
          onChange={(e) => onFieldChange('status', e.target.value)}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </label>

      <label className="text-sm text-gray-700">
        Option Type
        <select
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.option_type}
          onChange={(e) => onFieldChange('option_type', e.target.value)}
        >
          <option value="">None</option>
          <option value="C">Call</option>
          <option value="P">Put</option>
        </select>
      </label>

      <label className="text-sm text-gray-700">
        Strike Price
        <input
          type="number"
          step="any"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.strike_price}
          onChange={(e) => onFieldChange('strike_price', e.target.value)}
          placeholder="Optional"
        />
      </label>

      <label className="text-sm text-gray-700">
        Expiration
        <input
          type="date"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.expiration_date}
          onChange={(e) => onFieldChange('expiration_date', e.target.value)}
        />
      </label>

      <label className="text-sm text-gray-700">
        Option Code
        <input
          type="text"
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          value={form.option_code}
          onChange={(e) => onFieldChange('option_code', e.target.value)}
          placeholder="YYMMDDC150"
        />
      </label>
    </div>
  );
}

export function Transactions() {
  const queryClient = useQueryClient();
  const createFormCardRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filter, setFilter] = useState<Omit<TransactionFilter, 'limit' | 'offset'>>({});
  const [createForm, setCreateForm] = useState<TransactionFormState>(
    getDefaultTransactionForm()
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditTransactionState | null>(null);
  const offset = (page - 1) * pageSize;
  const queryFilter: TransactionFilter = { ...filter, limit: pageSize, offset };
  const hideClosed = filter.status === 'open';
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });
  const { data: tickers = [] } = useQuery({
    queryKey: ['tickers'],
    queryFn: tickersApi.list,
  });
  const tickerBySymbol = useMemo(
    () => new Map(tickers.map((ticker) => [ticker.symbol.toUpperCase(), ticker.id])),
    [tickers]
  );
  const accountIdByCode = useMemo(
    () => new Map(accounts.map((account) => [account.code, account.id])),
    [accounts]
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['transactions', queryFilter],
    queryFn: () => transactionsApi.list(queryFilter),
  });
  const transactions = data?.items ?? EMPTY_TRANSACTIONS;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + pageSize, total);
  const transactionTypes = useMemo(
    () => Array.from(new Set([...TRANSACTION_TYPES, ...transactions.map((tx) => tx.transaction_type)])).sort(),
    [transactions]
  );

  const invalidatePortfolioQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['positions'] });
    queryClient.invalidateQueries({ queryKey: ['summary'] });
    queryClient.invalidateQueries({ queryKey: ['yield-metrics'] });
    queryClient.invalidateQueries({ queryKey: ['accounts-performance'] });
    queryClient.invalidateQueries({ queryKey: ['tickers'] });
  };

  const deleteMutation = useMutation({
    mutationFn: transactionsApi.delete,
    onSuccess: () => {
      invalidatePortfolioQueries();
    },
  });

  const createMutation = useMutation({
    mutationFn: transactionsApi.create,
    onSuccess: () => {
      setCreateError(null);
      setCreateForm(getDefaultTransactionForm());
      setPage(1);
      invalidatePortfolioQueries();
    },
    onError: (error: unknown) => {
      setCreateError(parseApiError(error, 'Failed to create transaction'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateTransactionRequest }) =>
      transactionsApi.update(id, data),
    onSuccess: () => {
      setEditState(null);
      invalidatePortfolioQueries();
    },
    onError: (error: unknown) => {
      setEditState((prev) =>
        prev ? { ...prev, error: parseApiError(error, 'Failed to update transaction') } : prev
      );
    },
  });

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this transaction?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleCreateField = <K extends keyof TransactionFormState>(
    field: K,
    value: TransactionFormState[K]
  ) => {
    setCreateForm((prev) => {
      const normalizedValue =
        field === 'option_code' || field === 'ticker_symbol'
          ? value.toUpperCase()
          : value;
      const next = { ...prev, [field]: normalizedValue };
      return applyOptionCodeDerivedFields(next, field);
    });
  };

  const handleEditField = <K extends keyof TransactionFormState>(
    field: K,
    value: TransactionFormState[K]
  ) => {
    setEditState((prev) =>
      prev
        ? {
            ...prev,
            form: applyOptionCodeDerivedFields(
              {
                ...prev.form,
                [field]:
                  field === 'option_code' || field === 'ticker_symbol'
                    ? value.toUpperCase()
                    : value,
              },
              field
            ),
            error: null,
          }
        : prev
    );
  };

  const handleAutoCost = () => {
    const cost = calculateExactCost(createForm.quantity, createForm.price);
    if (cost != null) {
      handleCreateField('cost', cost);
    }
  };

  const handleEditAutoCost = () => {
    if (!editState) {
      return;
    }
    const cost = calculateExactCost(editState.form.quantity, editState.form.price);
    if (cost != null) {
      handleEditField('cost', cost);
    }
  };

  const handleCreateSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreateError(null);

    const normalized = normalizeTransactionForm(createForm);
    if (!normalized.payload) {
      setCreateError(normalized.error);
      return;
    }

    const payload: CreateTransactionRequest = {
      account_id: normalized.payload.account_id,
      ticker_id: tickerBySymbol.get(normalized.payload.symbol),
      ticker_symbol: normalized.payload.symbol,
      transaction_type: normalized.payload.transaction_type,
      quantity: normalized.payload.quantity,
      price: normalized.payload.price,
      cost: normalized.payload.cost,
      fees: normalized.payload.fees,
      date: normalized.payload.date,
      option_type: normalized.payload.option_type,
      strike_price: normalized.payload.strike_price,
      expiration_date: normalized.payload.expiration_date,
      option_code: normalized.payload.option_code,
      status: normalized.payload.status,
    };

    createMutation.mutate(payload);
  };

  const handleEdit = (transaction: TransactionWithDetails) => {
    const form = transactionToForm(transaction, accountIdByCode);
    if (!form.account_id) {
      alert(`Account ${transaction.account_code} is not available for editing.`);
      return;
    }

    setEditState({
      transactionId: transaction.id,
      transactionLabel: `${transaction.account_code} · ${transaction.ticker_symbol} · ${transaction.transaction_type}`,
      form,
      error: null,
    });
  };

  const handleNewFromTransaction = (transaction: TransactionWithDetails) => {
    const form = transactionToForm(transaction, accountIdByCode);
    if (!form.account_id) {
      alert(`Account ${transaction.account_code} is not available for templating.`);
      return;
    }

    setCreateError(null);
    setCreateForm(form);
    createFormCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleEditSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editState) {
      return;
    }

    const normalized = normalizeTransactionForm(editState.form);
    if (!normalized.payload) {
      setEditState((prev) => (prev ? { ...prev, error: normalized.error } : prev));
      return;
    }

    const payload: UpdateTransactionRequest = {
      account_id: normalized.payload.account_id,
      ticker_id: tickerBySymbol.get(normalized.payload.symbol),
      ticker_symbol: normalized.payload.symbol,
      transaction_type: normalized.payload.transaction_type,
      quantity: normalized.payload.quantity,
      price: normalized.payload.price,
      cost: normalized.payload.cost,
      fees: normalized.payload.fees,
      date: normalized.payload.date,
      option_type: normalized.payload.option_type,
      strike_price: normalized.payload.strike_price,
      expiration_date: normalized.payload.expiration_date,
      option_code: normalized.payload.option_code,
      status: normalized.payload.status,
    };

    updateMutation.mutate({ id: editState.transactionId, data: payload });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        <div className="flex space-x-4">
          <select
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={filter.account_id?.toString() || ''}
            onChange={(e) => {
              setPage(1);
              const accountId = e.target.value ? Number(e.target.value) : undefined;
              setFilter({ ...filter, account_id: accountId });
            }}
          >
            <option value="">All Accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Symbol (e.g. AAPL)"
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={filter.symbol || ''}
            onChange={(e) => {
              setPage(1);
              const symbol = e.target.value.trim();
              setFilter({ ...filter, symbol: symbol || undefined });
            }}
          />
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              checked={hideClosed}
              onChange={(e) => {
                setPage(1);
                setFilter({ ...filter, status: e.target.checked ? 'open' : undefined });
              }}
            />
            Hide Closed
          </label>
          <select
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={filter.status || ''}
            onChange={(e) => {
              setPage(1);
              setFilter({ ...filter, status: e.target.value || undefined });
            }}
          >
            <option value="">All Status</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
          <select
            className="block rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            value={filter.transaction_type || ''}
            onChange={(e) => {
              setPage(1);
              setFilter({ ...filter, transaction_type: e.target.value || undefined });
            }}
          >
            <option value="">All Types</option>
            <option value="Buy">Buy</option>
            <option value="Sell">Sell</option>
            <option value="Sell short">Sell Short</option>
            <option value="Buy to cover">Buy to Cover</option>
            <option value="Assigned">Assigned</option>
            <option value="Dividend">Dividend</option>
          </select>
        </div>
      </div>

      <div ref={createFormCardRef} className="bg-white shadow rounded-lg p-4">
        <h2 className="text-base font-semibold text-gray-900">Add Transaction</h2>
        <form className="mt-4 space-y-4" onSubmit={handleCreateSubmit}>
          <TransactionFormFields
            accounts={accounts}
            tickers={tickers}
            transactionTypes={transactionTypes}
            form={createForm}
            symbolOptionsId="create-transaction-symbol-options"
            onFieldChange={(field, value) => handleCreateField(field, value)}
            onAutoCost={handleAutoCost}
          />

          {createError ? <div className="text-sm text-red-600">{createError}</div> : null}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Saving...' : 'Add Transaction'}
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setCreateError(null);
                setCreateForm(getDefaultTransactionForm());
              }}
              disabled={createMutation.isPending}
            >
              Reset
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white shadow rounded-lg">
        {isLoading ? (
          <div className="p-4 text-gray-500">Loading...</div>
        ) : transactions.length > 0 ? (
          <TransactionTable
            transactions={transactions}
            onNew={handleNewFromTransaction}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ) : (
          <div className="p-4 text-gray-500">No transactions found</div>
        )}

        <div className="flex flex-col gap-3 border-t border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-gray-600">
            Showing {start}-{end} of {total}
            {isFetching && !isLoading ? ' (updating...)' : ''}
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-600">
              Rows
              <select
                className="ml-2 rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>

            <button
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || isFetching}
            >
              Prev
            </button>
            <span className="text-sm text-gray-700">
              Page {page} / {totalPages}
            </span>
            <button
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || isFetching}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {editState ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-5xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Edit Transaction</h2>
                <p className="mt-1 text-xs text-gray-500">
                  #{editState.transactionId} · {editState.transactionLabel}
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => setEditState(null)}
                disabled={updateMutation.isPending}
              >
                Close
              </button>
            </div>

            <form className="space-y-4 px-5 py-4" onSubmit={handleEditSubmit}>
              <TransactionFormFields
                accounts={accounts}
                tickers={tickers}
                transactionTypes={transactionTypes}
                form={editState.form}
                symbolOptionsId="edit-transaction-symbol-options"
                onFieldChange={(field, value) => handleEditField(field, value)}
                onAutoCost={handleEditAutoCost}
              />

              {editState.error ? (
                <div className="text-sm text-red-600">{editState.error}</div>
              ) : null}

              <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setEditState(null)}
                  disabled={updateMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
