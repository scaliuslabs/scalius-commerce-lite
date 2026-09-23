import { unixToDate } from "@scalius/shared/timestamps";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { formatDateTime } from "~/i18n";
import { formatSavedMinorAmount } from "~/lib/order-tax-presentation";
import type { OrderTimestamp } from "./types";

function toDate(value: OrderTimestamp | null | undefined): Date | null {
  const date = unixToDate(value);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** Date and time in the store time zone, in the dashboard language. */
export function formatOrderTimestamp(value: OrderTimestamp | null | undefined): string | null {
  const date = toDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium", timeStyle: "short" }) : null;
}

export function formatOrderDate(value: OrderTimestamp | null | undefined): string | null {
  const date = toDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium" }) : null;
}

/** A major-unit amount in the given currency, e.g. "৳1,250.00". */
export function formatCurrencyAmount(amount: number, currency: string): string {
  const decimalPlaces = getDecimalPlaces(currency);
  const minor = Math.round((Number.isFinite(amount) ? amount : 0) * 10 ** decimalPlaces);
  return formatSavedMinorAmount(minor, { currencyCode: currency, decimalPlaces });
}
