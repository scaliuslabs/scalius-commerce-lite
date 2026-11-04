import { currencySymbol } from "@scalius/shared/money-format";
import type { SavedOrderMoneySummary } from "@scalius/shared/order-money-presentation";
import { formatNumber } from "~/i18n";

export function formatSavedMinorAmount(
  amountMinor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
): string {
  const amount = amountMinor / 10 ** summary.decimalPlaces;
  const formatted = formatNumber(Math.abs(amount), {
    minimumFractionDigits: summary.decimalPlaces,
    maximumFractionDigits: summary.decimalPlaces,
  });
  return `${amount < 0 ? "-" : ""}${currencySymbol(summary.currencyCode)}${formatted}`;
}

export function formatSavedMajorAmount(
  amountMajor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
): string {
  const factor = 10 ** summary.decimalPlaces;
  return formatSavedMinorAmount(Math.round(amountMajor * factor), summary);
}
