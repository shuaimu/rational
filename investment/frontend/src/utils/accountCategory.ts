import type { Account } from '../api/types';

export type AccountCategory = 'stock' | 'index';

const INDEX_ONLY_CODE_PATTERN = /#(?:403|457|529|ORP)$/i;

function normalizeAccountType(accountType: string | null | undefined): string {
  return (accountType ?? '').trim().toLowerCase();
}

export function getAccountCategory(account: Pick<Account, 'code' | 'account_type'>): AccountCategory {
  const normalizedType = normalizeAccountType(account.account_type);

  if (normalizedType.includes('index')) {
    return 'index';
  }

  if (normalizedType.includes('stock') || normalizedType.includes('free')) {
    return 'stock';
  }

  if (INDEX_ONLY_CODE_PATTERN.test(account.code ?? '')) {
    return 'index';
  }

  return 'stock';
}

export function getAccountCategoryTitle(category: AccountCategory): string {
  return category === 'stock'
    ? 'Category 1: Free Stock Trading Accounts'
    : 'Category 2: Index-Only Accounts';
}
