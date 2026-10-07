import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { formatDateTime, translate } from "~/i18n";
import { eventTimeMessages } from "~/i18n/event-time";
import { getStoreTimeZone } from "~/lib/store-time-zone";

type Translate = (key: "justNow" | "minutesAgo" | "todayAt" | "yesterdayAt" | "dateAt", vars?: Record<string, string | number>) => string;

/** The store-calendar day (days since 1970) and year of an instant. */
function storeDay(date: Date, timeZone: string): { day: number; year: string } {
  const key = commerceCalendarDateKey(timeZone, date);
  return { day: Date.parse(`${key}T00:00:00Z`) / 86_400_000, year: key.slice(0, 4) };
}

/**
 * The one way the dashboard writes when something happened, in store time
 * (Shopify's): recent events read relative ("Just now", "41 min ago", "Today
 * at 3:42 PM", "Yesterday at 3:42 PM", the weekday within a week), older ones
 * by their date with the month as a word ("Oct 3 at 3:42 PM", and
 * "Oct 3, 2025" for another year; `withTime` keeps the time then too). Never
 * a numeric date, which reads as two different days in two countries. A date
 * field (no time of day) is written "Oct 3, 2026" (`DateInput`).
 */
export function eventTimeLabel(date: Date, now: Date, t: Translate, { withTime = false }: { withTime?: boolean } = {}): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes >= 0 && minutes < 1) return t("justNow");
  if (minutes >= 1 && minutes < 60) return t("minutesAgo", { count: minutes });
  const time = formatDateTime(date, { hour: "numeric", minute: "2-digit" });
  const timeZone = getStoreTimeZone();
  const then = storeDay(date, timeZone);
  const today = storeDay(now, timeZone);
  const days = today.day - then.day;
  if (days === 0) return t("todayAt", { time });
  if (days === 1) return t("yesterdayAt", { time });
  if (days > 1 && days < 7) return t("dateAt", { date: formatDateTime(date, { weekday: "long" }), time });
  if (then.year === today.year) return t("dateAt", { date: formatDateTime(date, { month: "short", day: "numeric" }), time });
  const dated = formatDateTime(date, { month: "short", day: "numeric", year: "numeric" });
  // An event from another year is told by its date; a list shows the time on hover.
  return withTime ? t("dateAt", { date: dated, time }) : dated;
}

/** `eventTimeLabel` for now, in the dashboard language: for text that isn't a list cell. */
export function eventTime(value: Date | string | number | null | undefined, options?: { withTime?: boolean }): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return eventTimeLabel(date, new Date(), (key, vars) => translate(eventTimeMessages, key, vars), { withTime: true, ...options });
}
