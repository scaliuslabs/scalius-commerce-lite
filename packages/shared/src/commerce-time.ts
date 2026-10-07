// The merchant calendar: the store's IANA time zone (Settings → Store details
// → Store defaults) decides which day, week and month an instant belongs to.
// Every boundary is computed with `Intl` for the zone, so daylight saving time
// (US, EU, …) moves days by the right hour, and a zone without it (Asia/Dhaka)
// keeps fixed 24-hour days. Pure and host-timezone independent: the host's own
// zone is never consulted.

import { dateTimeFormatter } from "./locale-format";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

// The zone defaults and validation live with the other store defaults, so
// the platform settings read them without this module.
export { DEFAULT_STORE_TIME_ZONE, TIME_ZONE_MAX_LENGTH, isValidTimeZone, normalizeTimeZone } from "./store-defaults";

/** A zone's wall-clock parts (the formatting layer keeps one formatter per zone). */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return dateTimeFormatter("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** The zone's offset from UTC in seconds at an instant (east positive: Dhaka +21600). */
export function timeZoneOffsetSeconds(timeZone: string, epochSeconds: number): number {
  const instant = Math.floor(epochSeconds);
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant * 1000));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = field("hour") % 24;
  const wall = Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second")) / 1000;
  return wall - instant;
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

function dateKeyOfUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function toInstant(value: Date | number): number {
  const instant = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(instant)) {
    throw new RangeError("A valid instant is required for a commerce calendar date.");
  }
  return instant;
}

/** The YYYY-MM-DD merchant calendar date of an instant (milliseconds or a Date). */
export function commerceCalendarDateKey(timeZone: string, value: Date | number = new Date()): string {
  const instantMs = toInstant(value);
  const seconds = Math.floor(instantMs / 1000);
  return dateKeyOfUtcDay((seconds + timeZoneOffsetSeconds(timeZone, seconds)) * 1000);
}

/** Shift an already-normalized merchant date by whole days (zone-free). */
export function shiftCommerceCalendarDateKey(value: string, days: number): string {
  const parts = parseDateKey(value);
  if (!parts || !Number.isInteger(days)) {
    throw new RangeError("A valid commerce date and whole-day offset are required.");
  }
  return dateKeyOfUtcDay(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
}

/**
 * The first instant (epoch seconds) of a merchant day: local midnight, or,
 * when the zone skips midnight that day (a daylight saving gap at 00:00), the
 * first instant after the gap. When midnight occurs twice, the earlier one.
 */
export function commerceDayStart(timeZone: string, dateKey: string): number {
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError("A valid commerce date is required.");
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day) / 1000;
  // A day either side of the boundary: the zone's offset before and after it.
  const offsetBefore = timeZoneOffsetSeconds(timeZone, wall - DAY_SECONDS);
  const offsetAfter = timeZoneOffsetSeconds(timeZone, wall + DAY_SECONDS);
  const candidates = [...new Set([wall - offsetBefore, wall - offsetAfter])]
    .filter((instant) => instant + timeZoneOffsetSeconds(timeZone, instant) === wall)
    .sort((left, right) => left - right);
  if (candidates.length > 0) return candidates[0]!;
  // Midnight does not exist: the day starts at the first instant whose local
  // date is this day. Search the gap between the two candidate instants.
  let low = Math.min(wall - offsetBefore, wall - offsetAfter);
  let high = Math.max(wall - offsetBefore, wall - offsetAfter);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (commerceCalendarDateKey(timeZone, middle * 1000) >= dateKey) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** A merchant day as exact inclusive UTC epoch-second bounds (23, 24 or 25 hours long). */
export function commerceCalendarDayBounds(timeZone: string, dateKey: string): { start: number; end: number } {
  const start = commerceDayStart(timeZone, dateKey);
  const next = commerceDayStart(timeZone, shiftCommerceCalendarDateKey(dateKey, 1));
  return { start, end: next - 1 };
}

/** Exact current and previous merchant-month starts (epoch seconds). */
export function commerceMonthBounds(timeZone: string, value: Date | number = new Date()): {
  currentMonthStart: number;
  previousMonthStart: number;
} {
  const today = commerceCalendarDateKey(timeZone, value);
  const currentMonth = `${today.slice(0, 7)}-01`;
  const previousMonth = `${shiftCommerceCalendarDateKey(currentMonth, -1).slice(0, 7)}-01`;
  return {
    currentMonthStart: commerceDayStart(timeZone, currentMonth),
    previousMonthStart: commerceDayStart(timeZone, previousMonth),
  };
}

/**
 * The instant (epoch seconds) a merchant wall-clock time names, e.g. a
 * discount that starts "2026-03-29 09:00" in the store's zone. A time inside a
 * daylight saving gap moves forward past it; an ambiguous one is the earlier.
 * Null when the date or time is not real.
 */
export function commerceWallTimeToEpoch(timeZone: string, dateKey: string, hours: number, minutes: number): number | null {
  const parts = parseDateKey(dateKey);
  if (!parts || !Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes) / 1000;
  const offsetBefore = timeZoneOffsetSeconds(timeZone, wall - DAY_SECONDS);
  const offsetAfter = timeZoneOffsetSeconds(timeZone, wall + DAY_SECONDS);
  const candidates = [...new Set([wall - offsetBefore, wall - offsetAfter])]
    .filter((instant) => instant + timeZoneOffsetSeconds(timeZone, instant) === wall)
    .sort((left, right) => left - right);
  if (candidates.length > 0) return candidates[0]!;
  // In a gap: the same distance after the transition (02:30 → 03:30).
  return wall - offsetBefore;
}

/**
 * The zone's offsets over `[start, end)` (epoch seconds): the offset at
 * `start`, then each change with the instant it takes effect. A zone without
 * daylight saving has no changes. Days are sampled, then each change is found
 * to the second, so SQL can map an instant to its merchant day with integer
 * arithmetic and no calendar functions.
 */
export interface ZoneOffsetSchedule {
  initialOffset: number;
  changes: Array<{ at: number; offset: number }>;
}

export function zoneOffsetSchedule(timeZone: string, start: number, end: number): ZoneOffsetSchedule {
  const initialOffset = timeZoneOffsetSeconds(timeZone, start);
  const changes: ZoneOffsetSchedule["changes"] = [];
  let previousInstant = start;
  let previousOffset = initialOffset;
  for (let instant = start + DAY_SECONDS / 2; ; instant += DAY_SECONDS / 2) {
    const probe = Math.min(instant, end);
    const offset = timeZoneOffsetSeconds(timeZone, probe);
    if (offset !== previousOffset) {
      let low = previousInstant + 1;
      let high = probe;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (timeZoneOffsetSeconds(timeZone, middle) === previousOffset) low = middle + 1;
        else high = middle;
      }
      changes.push({ at: low, offset });
      previousOffset = offset;
    }
    previousInstant = probe;
    if (probe >= end) break;
  }
  return { initialOffset, changes };
}
