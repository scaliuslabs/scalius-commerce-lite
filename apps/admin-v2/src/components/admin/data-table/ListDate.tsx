import { useSyncExternalStore } from "react";
import { unixToDate } from "@scalius/shared/timestamps";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, useMessages } from "~/i18n";
import { eventTimeMessages } from "~/i18n/event-time";
import { eventTimeLabel } from "~/lib/event-time";

type Timestamp = Date | string | number | null | undefined;

/**
 * Shopify's list date, in store time: "Just now", "41 min ago", "Today at
 * 3:42 PM", "Yesterday at 3:42 PM", the weekday within the last week, then
 * "Oct 3 at 3:42 PM", and "Oct 3, 2025" for another year (`eventTimeLabel`,
 * the rule every date in the dashboard follows).
 */
export const listDateLabel = eventTimeLabel;

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
  const t = useMessages(eventTimeMessages);
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
