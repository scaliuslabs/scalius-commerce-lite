import { unixToDate } from "@scalius/shared/timestamps";
import type { OrderTimestamp } from "./types";

const ORDER_AMOUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const ORDER_TIME_ZONE = "Asia/Dhaka";

const ORDER_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ORDER_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const ORDER_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ORDER_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatOrderAmount(value: number | null | undefined): string {
  const amount = Number(value ?? 0);
  return ORDER_AMOUNT_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

function toOrderDate(value: OrderTimestamp | null | undefined): Date | null {
  const date = unixToDate(value);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function formatOrderTimestamp(
  value: OrderTimestamp | null | undefined,
): string | null {
  const date = toOrderDate(value);
  return date ? ORDER_TIMESTAMP_FORMATTER.format(date) : null;
}

export function formatOrderDate(
  value: OrderTimestamp | null | undefined,
): string | null {
  const date = toOrderDate(value);
  return date ? ORDER_DATE_FORMATTER.format(date) : null;
}
