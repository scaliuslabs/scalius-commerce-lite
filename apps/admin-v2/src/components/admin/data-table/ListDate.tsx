import { useSyncExternalStore } from "react";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { unixToDate } from "@scalius/shared/timestamps";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { getStoreTimeZone } from "~/lib/store-time-zone";

type Timestamp = Date | string | number | null | undefined;
type Translate = (key: "justNow" | "minutesAgo" | "todayAt" | "yesterdayAt" | "dateAt", vars?: Record<string, string | number>) => string;

/** The store-calendar day (days since 1970) and year of an instant. */
function storeDay(date: Date, timeZone: string): { day: number; year: string } {
  const key = commerceCalendarDateKey(timeZone, date);
  return { day: Date.parse(`${key}T00:00:00Z`) / 86_400_000, year: key.slice(0, 4) };
}

/**
 * Shopify's list date, in store time: "Just now", "41 min ago", "Today at
 * 3:42 PM", "Yesterday at 3:42 PM", the weekday within the last week
 * ("Wednesday at 3:42 PM"), then "Oct 3 at 3:42 PM", and "Oct 3, 2025" for
 * another year.
 */
export function listDateLabel(date: Date, now: Date, t: Translate): string {
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
  // An order from another year is told by its date; the time is on hover.
  return formatDateTime(date, { month: "short", day: "numeric", year: "numeric" });
}

// One clock for every date on screen: labels move on ("41 min ago", "Today"
// becoming "Yesterday") without a timer per row.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const currentMinute = () => Math.floor(Date.now() / 60_000);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), 15_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The widest label and the cell's padding, by dashboard language (`list-layout.test.tsx`). */
export const LIST_DATE_WIDTH = { en: 164, bn: 132 } as const;

/** A list's created or updated date (`listDateLabel`), the full date and time on hover. */
export function ListDate({ value, className }: { value: Timestamp; className?: string }) {
  const t = useMessages(dataTableMessages);
  const minute = useSyncExternalStore(subscribe, currentMinute, currentMinute);
  const date = unixToDate(value ?? null);
  const base = cn("whitespace-nowrap text-muted-foreground", className);
  if (!date || Number.isNaN(date.getTime())) return <span className={base}>—</span>;
  return (
    <span className={base} title={formatDateTime(date, { dateStyle: "full", timeStyle: "short" })}>
      {listDateLabel(date, new Date(Math.max(Date.now(), minute * 60_000)), t)}
    </span>
  );
}
