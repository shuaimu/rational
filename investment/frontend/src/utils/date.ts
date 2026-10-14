const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDateOnly(value: string): Date | null {
  if (!ISO_DATE_ONLY_RE.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function formatLocalDateInputValue(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateOnly(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
): string {
  if (!value) {
    return '-';
  }

  const parsed = parseIsoDateOnly(value);
  if (parsed) {
    return parsed.toLocaleDateString('en-US', options);
  }

  const fallback = new Date(value);
  if (Number.isNaN(fallback.getTime())) {
    return value;
  }

  return fallback.toLocaleDateString('en-US', options);
}

export function isoDateYearsAgo(years: number): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return formatLocalDateInputValue(date);
}

export function isBeforeToday(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const parsed = parseIsoDateOnly(value);
  if (!parsed) {
    return false;
  }

  return formatLocalDateInputValue(parsed) < formatLocalDateInputValue();
}
