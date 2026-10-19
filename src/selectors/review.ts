import { isCategory, type TaxonomyEntry, type Transaction } from "../model/types.js";
import { memoizeLast } from "./memo.js";
import { sortTransactions } from "./transactions.js";

/**
 * Review is a request for attention, not the absence of an approval.
 * Explicit true/false preserve Reviewed/Needs Review from Monarch and manual
 * choices. An unspecified imported status stays neutral, even after bank linking.
 * New bank rows without a choice need review only while uncategorized.
 */
export function reviewPredicate(categories: readonly TaxonomyEntry[] = []): (transaction: Transaction) => boolean {
  const uncategorized = new Set(categories
    .filter((entry) => isCategory(entry) && entry.name.trim().toLowerCase() === "uncategorized")
    .map((entry) => entry.id));
  const missingCategory = (id: string | undefined) => !id || uncategorized.has(id);
  return (transaction) => {
    if (transaction.reviewed !== undefined) return transaction.reviewed === false;
    if (transaction.import_batch_id) return false;
    if (!transaction.external_id || transaction.adjustment || transaction.transfer_id) return false;
    return transaction.splits.length > 0
      ? transaction.splits.some((split) => missingCategory(split.category_id))
      : missingCategory(transaction.category_id);
  };
}

export function needsReview(transaction: Transaction, categories: readonly TaxonomyEntry[] = []): boolean {
  return reviewPredicate(categories)(transaction);
}

/** Newest first, so what arrived last night is at the top. */
export function reviewQueue(transactions: readonly Transaction[], categories: readonly TaxonomyEntry[] = []): Transaction[] {
  return sortTransactions(transactions.filter(reviewPredicate(categories)));
}

export function reviewCount(transactions: readonly Transaction[], categories: readonly TaxonomyEntry[] = []): number {
  const needsReview = reviewPredicate(categories);
  let count = 0;
  for (const transaction of transactions) if (needsReview(transaction)) count += 1;
  return count;
}

export const selectReviewQueue = memoizeLast(reviewQueue);
export const selectReviewCount = memoizeLast(reviewCount);
