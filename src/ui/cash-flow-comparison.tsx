import {
  BarChart, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  type ChartSeries, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn,
} from "@mako-cloud/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { type CalendarPeriod, type PeriodFlow, rangeLabel } from "../selectors/cashflow.js";
import { formatMinorUnits } from "../selectors/money.js";
import { compactMoney } from "./charts/layout.js";

const SERIES: ReadonlyArray<ChartSeries> = [
  { key: "income", label: "Income", color: "var(--chart-2)" },
  { key: "spending", label: "Spending", color: "var(--chart-1)" },
];
const PAGE_SIZE = 12;
const LABELS = {
  month: { title: "Income and spending by month", table: "Month by month", column: "Month" },
  quarter: { title: "Income and spending by quarter", table: "Quarter by quarter", column: "Quarter" },
  year: { title: "Income and spending by year", table: "Year by year", column: "Year" },
};

function axisPeriod(value: string | number): string {
  const key = String(value);
  if (/^\d{4}-\d{2}$/u.test(key)) return `${rangeLabel(key).slice(0, 3)} '${key.slice(2, 4)}`;
  if (key.includes("-Q")) return `${key.slice(5)} '${key.slice(2, 4)}`;
  return key;
}

/** The comparison is independent of the selected period's detail cards. */
export function CashFlowComparison({ rows, period, selected, currency, onSelect }: {
  rows: readonly PeriodFlow[];
  period: CalendarPeriod;
  selected: string;
  currency: string;
  onSelect: (key: string) => void;
}) {
  const selectedIndex = rows.findIndex((row) => row.period === selected);
  const lastIndex = rows.length - 1;
  const initialEnd = selectedIndex >= 0 && selectedIndex <= lastIndex - PAGE_SIZE
    ? Math.max(PAGE_SIZE - 1, selectedIndex)
    : lastIndex;
  const [window, setWindow] = useState({ selected, end: rows[initialEnd]?.period });
  const storedEnd = rows.findIndex((row) => row.period === window.end);
  let end = storedEnd < 0 ? lastIndex : storedEnd;
  let start = Math.max(0, end - PAGE_SIZE + 1);
  // Only a new selection moves the window to reveal it. Paging through
  // history leaves the detail selection alone; clicking a visible bar stays put.
  if (window.selected !== selected) {
    if (selectedIndex >= 0 && (selectedIndex < start || selectedIndex > end)) {
      end = Math.min(lastIndex, Math.max(PAGE_SIZE - 1, selectedIndex));
      start = Math.max(0, end - PAGE_SIZE + 1);
    }
    setWindow({ selected, end: rows[end]?.period });
  }
  const visible = useMemo(() => rows.slice(start, end + 1), [rows, start, end]);
  const data = useMemo(() => visible.map((row) => ({
    period: row.period, income: row.income, spending: row.spending,
  })), [visible]);
  const money = useCallback((value: number) => formatMinorUnits(value, currency), [currency]);
  const tickMoney = useCallback((value: number) => compactMoney(value, currency), [currency]);
  const labels = LABELS[period];
  const page = (direction: -1 | 1): void => {
    const nextEnd = Math.min(lastIndex, Math.max(Math.min(PAGE_SIZE - 1, lastIndex), end + direction * PAGE_SIZE));
    setWindow({ selected, end: rows[nextEnd]?.period });
  };

  return (
    <Card className="min-w-0" aria-labelledby="comparison-title" data-testid="cash-flow-comparison">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle id="comparison-title">{labels.title}</CardTitle>
          <CardDescription>Select a bar to see that {period}’s details below.</CardDescription>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Comparison history">
          <Button variant="ghost" size="icon-sm" aria-label={`Earlier ${period}s`} disabled={start === 0} onClick={() => page(-1)}>
            <ChevronLeft />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="comparison-span">
            {rangeLabel(visible[0]?.period ?? "")} – {rangeLabel(visible[visible.length - 1]?.period ?? "")}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={`Later ${period}s`} disabled={end >= lastIndex} onClick={() => page(1)}>
            <ChevronRight />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3">
        <div className="overflow-x-auto" data-testid="comparison-scroll">
          <div className="min-w-[36rem]">
            <BarChart
              data={data}
              x="period"
              series={SERIES}
              title={labels.title}
              height={240}
              formatValue={money}
              formatTick={tickMoney}
              formatX={axisPeriod}
              onSelect={onSelect}
              {...(selectedIndex < 0 ? {} : { selectedX: selected })}
            />
          </div>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-muted-foreground">{labels.table}</summary>
          <Table aria-label={labels.table} className="mt-3">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{labels.column}</TableHead>
                <TableHead scope="col" className="text-right">Income</TableHead>
                <TableHead scope="col" className="text-right">Spending</TableHead>
                <TableHead scope="col" className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.period} data-testid={`period-${row.period}`} className={cn(row.period === selected && "bg-accent")}>
                  <TableHead scope="row" className="font-medium text-foreground">
                    <Button variant="ghost" size="sm" aria-pressed={row.period === selected} onClick={() => onSelect(row.period)}>
                      {rangeLabel(row.period)}
                    </Button>
                  </TableHead>
                  <TableCell className="money text-right text-positive" data-testid="income">{money(row.income)}</TableCell>
                  <TableCell className="money text-right" data-testid="spending">{money(row.spending)}</TableCell>
                  <TableCell className={cn("money text-right", row.net < 0 && "text-destructive")} data-testid="net">{money(row.net)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </CardContent>
    </Card>
  );
}
