import { unixToDate } from "@scalius/shared/timestamps";
import { formatDateTime } from "~/i18n";
import { eventTime } from "~/lib/event-time";

/** A YYYY-MM-DD day (expected arrival) in the dashboard language, or null. */
export function formatDay(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // A date-only key: noon UTC formatted in UTC is that day in any store zone.
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : formatDateTime(date, { dateStyle: "medium", timeZone: "UTC" });
}

/** An API timestamp with date and time, or null. */
export function formatMoment(value: string | number | null | undefined): string | null {
  const date = unixToDate(value ?? null);
  return date ? eventTime(date) : null;
}

/** A product line's name: the product, then its option values ("Kori Trainer · 42"). */
export function lineName(line: { productName: string | null; optionLabel: string | null }, unknown: string): string {
  return [line.productName ?? unknown, line.optionLabel].filter(Boolean).join(" · ");
}
