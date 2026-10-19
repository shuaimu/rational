import { isBankReconciliation, type BalanceAccount, type BalanceTransaction, type ReportedBalance } from "./balances.ts";

export interface HistoricalBalance {
  readonly date: string;
  readonly balance: number;
  readonly estimated: boolean;
  readonly source?: string;
  readonly observedAt?: number;
}

/** Daily estimates are calculated from observations; they are never saved as bank reports. */
export function dailyBalanceHistory(
  account: BalanceAccount & { readonly opening_date: string },
  transactions: readonly (BalanceTransaction & { readonly date: string })[],
  observations: readonly ReportedBalance[],
  end: string,
  start?: string,
): HistoricalBalance[] {
  const reports = observations.filter(report => report.account_id === account.id &&
    report.household_id === account.household_id && report.currency === account.currency &&
    report.date <= end && Number.isSafeInteger(report.balance))
    .sort((a, b) => a.date.localeCompare(b.date) || a.observed_at - b.observed_at);
  const byDate = new Map(reports.map(report => [report.date, report]));
  const posted = transactions.filter(tx => tx.account_id === account.id && !tx.pending &&
    !isBankReconciliation(tx) && tx.date <= end);
  const dates = [account.opening_date, ...posted.map(tx => tx.date), ...byDate.keys()]
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= end).sort();
  const first = dates[0];
  if (!first) return [];
  const amounts = new Map<string, number>();
  for (const tx of posted) amounts.set(tx.date, (amounts.get(tx.date) ?? 0) + tx.amount);
  const daily: { date: string; sum: number }[] = [];
  const sums = new Map<string, number>();
  let sum = 0;
  for (let ms = Date.parse(first); ms <= Date.parse(end); ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    sum += amounts.get(date) ?? 0;
    sums.set(date, sum); daily.push({ date, sum });
  }
  let anchor = reports[0] ? byDate.get(reports[0].date) : undefined;
  return daily.flatMap(day => {
    const report = byDate.get(day.date);
    if (report) anchor = report;
    if (start && day.date < start) return [];
    return [{ date: day.date,
      balance: report?.balance ?? (anchor ? anchor.balance + day.sum - (sums.get(anchor.date) ?? 0) : account.opening_balance + day.sum),
      estimated: !report,
      ...(report ? { source: report.source, observedAt: report.observed_at } : {}),
    }];
  });
}
