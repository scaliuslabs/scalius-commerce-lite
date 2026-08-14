const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The merchant calendar boundary used by checkout, reporting, and admin UI. */
export const COMMERCE_TIME_ZONE = "Asia/Dhaka";
export const COMMERCE_UTC_OFFSET_SECONDS = 6 * 60 * 60;

function parseDateKey(value: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ? date
    : null;
}

/** Return the YYYY-MM-DD merchant calendar date for an absolute instant. */
export function commerceCalendarDateKey(value: Date | number = new Date()): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("A valid instant is required for a commerce calendar date.");
  }

  return new Date(
    instant.getTime() + COMMERCE_UTC_OFFSET_SECONDS * 1000,
  ).toISOString().slice(0, 10);
}

/** Shift an already-normalized merchant date without consulting the host timezone. */
export function shiftCommerceCalendarDateKey(value: string, days: number): string {
  const date = parseDateKey(value);
  if (!date || !Number.isInteger(days)) {
    throw new RangeError("A valid commerce date and whole-day offset are required.");
  }

  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Convert a merchant date into its exact inclusive UTC epoch-second bounds. */
export function commerceCalendarDayBounds(value: string): {
  start: number;
  end: number;
} {
  const date = parseDateKey(value);
  if (!date) throw new RangeError("A valid commerce date is required.");

  const start = Math.floor(date.getTime() / 1000) - COMMERCE_UTC_OFFSET_SECONDS;
  return { start, end: start + 24 * 60 * 60 - 1 };
}

/** Exact current and previous merchant-month UTC boundaries. */
export function commerceMonthBounds(value: Date | number = new Date()): {
  currentMonthStart: number;
  previousMonthStart: number;
} {
  const currentDate = parseDateKey(commerceCalendarDateKey(value));
  if (!currentDate) throw new RangeError("A valid instant is required.");

  const year = currentDate.getUTCFullYear();
  const month = currentDate.getUTCMonth();
  const offset = COMMERCE_UTC_OFFSET_SECONDS;

  return {
    currentMonthStart: Math.floor(Date.UTC(year, month, 1) / 1000) - offset,
    previousMonthStart: Math.floor(Date.UTC(year, month - 1, 1) / 1000) - offset,
  };
}

/** Format a date-only merchant key without shifting it through the viewer timezone. */
export function formatCommerceCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
  locale = "en-US",
): string {
  const date = parseDateKey(value);
  if (!date) return value;

  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: "UTC",
  }).format(date);
}
