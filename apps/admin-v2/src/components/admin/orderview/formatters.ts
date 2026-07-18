import {
  formatAdminDate,
  formatAdminTimestamp,
} from "~/lib/admin-time";
import type { OrderTimestamp } from "./types";

const ORDER_AMOUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function formatOrderAmount(value: number | null | undefined): string {
  const amount = Number(value ?? 0);
  return ORDER_AMOUNT_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

export function formatOrderTimestamp(
  value: OrderTimestamp | null | undefined,
): string | null {
  return formatAdminTimestamp(value);
}

export function formatOrderDate(
  value: OrderTimestamp | null | undefined,
): string | null {
  return formatAdminDate(value);
}
