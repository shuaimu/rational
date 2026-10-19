import { Button, Field, Input, Popover, PopoverContent, PopoverTrigger, cn } from "@mako-cloud/ui";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  type CalendarPeriod,
  type DateRange,
  type RangeKey,
  calendarPeriodFor,
  calendarRangeKey,
  customRangeKey,
  inRange,
  monthLabel,
  rangeFor,
  rangeLabel,
  shiftRange,
} from "../selectors/cashflow.js";
import { isIsoDate, monthKey } from "../selectors/transactions.js";

const PERIODS = [
  { key: "month", label: "Monthly" },
  { key: "quarter", label: "Quarterly" },
  { key: "year", label: "Yearly" },
] as const;

/** Keep the chosen month when zooming out to its year and back in again. */
export function CashFlowPeriodPicker({
  rangeKey,
  range,
  today,
  onChange,
}: {
  rangeKey: RangeKey;
  range: DateRange | null;
  today: string;
  onChange: (key: RangeKey) => void;
}) {
  const period = calendarPeriodFor(rangeKey);
  const [open, setOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(inRange(today, range) ? today : range!.start);
  // A shared link or browser Back can select a range outside the remembered month.
  const anchor = inRange(selectedDate, range) ? selectedDate : range!.start;
  const choose = (key: RangeKey): void => {
    const next = rangeFor(key, today);
    setSelectedDate(inRange(today, next) ? today : next!.start);
    setOpen(false);
    onChange(key);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid="range-bar">
      <div
        role="group"
        aria-label="Cash flow period"
        className="inline-flex rounded-full bg-muted p-1"
      >
        {PERIODS.map((entry) => (
          <Button
            key={entry.key}
            variant="ghost"
            aria-pressed={period === entry.key}
            className={cn(
              "h-8 rounded-full px-4 text-muted-foreground",
              period === entry.key &&
                "bg-background text-foreground shadow-sm aria-pressed:bg-background",
            )}
            onClick={() => {
              setOpen(false);
              setSelectedDate(anchor);
              onChange(calendarRangeKey(anchor, entry.key));
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <div role="group" aria-label="Selected period" className="flex min-w-0 items-center gap-1">
        {period === null ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous period"
            onClick={() => choose(shiftRange(rangeKey, -1))}
          >
            <ChevronLeft />
          </Button>
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="min-w-0 gap-2 font-semibold tabular-nums"
              aria-label={`Choose period: ${rangeLabel(rangeKey)}`}
            >
              <CalendarDays className="size-4 text-muted-foreground" />
              <span data-testid="range-label" className="truncate">
                {rangeLabel(rangeKey)}
              </span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label="Choose cash flow period"
            className="w-80 max-w-[calc(100vw-2rem)] p-3"
          >
            <PeriodCalendar
              key={`${rangeKey}:${open}`}
              rangeKey={rangeKey}
              anchor={anchor}
              today={today}
              onChange={choose}
            />
          </PopoverContent>
        </Popover>
        {period === null ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next period"
            onClick={() => choose(shiftRange(rangeKey, 1))}
          >
            <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}

function PeriodCalendar({
  rangeKey,
  anchor,
  today,
  onChange,
}: {
  rangeKey: RangeKey;
  anchor: string;
  today: string;
  onChange: (key: RangeKey) => void;
}) {
  const period = calendarPeriodFor(rangeKey) ?? "month";
  const [year, setYear] = useState(Number(anchor.slice(0, 4)));
  const [chooseYear, setChooseYear] = useState(period === "year");
  const [custom, setCustom] = useState(rangeKey.startsWith("custom:"));
  const firstYear = Math.floor(year / 12) * 12;
  const step = chooseYear ? 12 : 1;
  const yearText = String(year).padStart(4, "0");
  const choiceCount = !chooseYear && period === "quarter" ? 4 : 12;
  const choices = Array.from({ length: choiceCount }, (_, index) => {
    const key = chooseYear
      ? String(firstYear + index).padStart(4, "0")
      : period === "quarter"
        ? `${yearText}-Q${index + 1}`
        : `${yearText}-${String(index + 1).padStart(2, "0")}`;
    return {
      key,
      label: chooseYear ? key : period === "quarter" ? `Q${index + 1}` : monthLabel(key).slice(0, 3),
      detail: !chooseYear && period === "quarter"
        ? `${monthLabel(`${yearText}-${index * 3 + 1}`).slice(0, 3)} – ${monthLabel(`${yearText}-${index * 3 + 3}`).slice(0, 3)}`
        : null,
    };
  });

  return (
    <div className="grid gap-3">
      {custom ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">Custom dates</span>
            <Button variant="ghost" size="sm" onClick={() => setCustom(false)}>
              Back to calendar
            </Button>
          </div>
          <CustomRange range={rangeFor(rangeKey, today)} today={today} onApply={onChange} />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={chooseYear ? "Earlier years" : "Previous year"}
              disabled={year - step < 1}
              onClick={() => setYear(year - step)}
            >
              <ChevronLeft />
            </Button>
            {chooseYear ? (
              <span className="text-sm font-semibold tabular-nums">
                {firstYear} – {firstYear + 11}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Choose year: ${year}`}
                onClick={() => setChooseYear(true)}
              >
                {year}
                <ChevronDown />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={chooseYear ? "Later years" : "Next year"}
              disabled={year + step > 9999}
              onClick={() => setYear(year + step)}
            >
              <ChevronRight />
            </Button>
          </div>
          <div
            className={cn("grid gap-1", !chooseYear && period === "quarter" ? "grid-cols-2" : "grid-cols-3")}
          >
            {choices.map((choice) => (
              <Button
                key={choice.key}
                variant="ghost"
                aria-label={rangeLabel(choice.key)}
                aria-pressed={
                  choice.key === rangeKey || (chooseYear && choice.key === anchor.slice(0, 4))
                }
                disabled={Number(choice.key) === 0 || (chooseYear && Number(choice.key) > 9999)}
                className="h-auto min-h-11 flex-col gap-0.5 py-2 tabular-nums"
                onClick={() => {
                  if (chooseYear && period !== "year") {
                    setYear(Number(choice.key));
                    setChooseYear(false);
                  } else {
                    onChange(choice.key);
                  }
                }}
              >
                {choice.label}
                {choice.detail === null ? null : (
                  <span className="text-xs font-normal text-muted-foreground">{choice.detail}</span>
                )}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-1 border-t pt-2">
            <Button variant="ghost" size="sm" onClick={() => onChange(calendarRangeKey(today, period))}>
              This {period}
            </Button>
            <Button variant="ghost" size="sm" aria-pressed={rangeKey === "all"} onClick={() => onChange("all")}>
              All time
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCustom(true)}>
              Custom dates
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CustomRange({
  range,
  today,
  onApply,
}: {
  range: DateRange | null;
  today: string;
  onApply: (key: RangeKey) => void;
}) {
  const [start, setStart] = useState(range?.start ?? `${monthKey(today)}-01`);
  const [end, setEnd] = useState(range?.end ?? today);
  const valid = isIsoDate(start) && isIsoDate(end);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) onApply(customRangeKey(start <= end ? { start, end } : { start: end, end: start }));
  };
  return (
    <form className="grid gap-3" aria-label="Custom range" onSubmit={submit}>
      <Field label="From" htmlFor="range-from">
        <Input
          id="range-from"
          type="date"
          name="from"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </Field>
      <Field label="To" htmlFor="range-to">
        <Input
          id="range-to"
          type="date"
          name="to"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </Field>
      <Button type="submit" disabled={!valid}>
        Apply
      </Button>
    </form>
  );
}
