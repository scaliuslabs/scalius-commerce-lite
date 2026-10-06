import { unixToDate } from "@scalius/shared/timestamps";
import {
  commerceCalendarDateKey,
  formatCommerceCalendarDate,
} from "@scalius/shared/commerce-time";
import { getStoreTimeZone } from "./store-time-zone";

export type AdminTimestamp = Date | string | number;

// Formatters per zone: the store's zone is one value for the tab's life, but
// can change once (the store-defaults read, a saved setting).
const FORMATTERS = new Map<string, { timestamp: Intl.DateTimeFormat; date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();

function formatters(timeZone: string) {
  let found = FORMATTERS.get(timeZone);
  if (!found) {
    found = {
      timestamp: new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
      date: new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }),
      time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };
    FORMATTERS.set(timeZone, found);
  }
  return found;
}

function toAdminDate(
  value: AdminTimestamp | null | undefined,
): Date | null {
  const date = unixToDate(value);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** "Jul 19, 2026, 2:53 AM" in store time. */
export function formatAdminTimestamp(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? formatters(getStoreTimeZone()).timestamp.format(date) : null;
}

export function formatAdminDate(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? formatters(getStoreTimeZone()).date.format(date) : null;
}

export function formatAdminTime(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? formatters(getStoreTimeZone()).time.format(date) : null;
}

export function formatAdminCalendarDate(
  value: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatCommerceCalendarDate(value, options);
}

/** Today (or an instant's day) on the store calendar, as YYYY-MM-DD. */
export function adminCalendarDateKey(value: Date | number = new Date()): string {
  return commerceCalendarDateKey(getStoreTimeZone(), value);
}
