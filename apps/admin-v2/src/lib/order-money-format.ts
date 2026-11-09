import { currencySymbol } from "@scalius/shared/money-format";
import type { SavedOrderMoneySummary } from "@scalius/shared/order-money-presentation";
import { formatNumber } from "~/i18n";

export function formatSavedMinorAmount(
  amountMinor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
  /** The language's number format (`useLocaleFormat`); absent: the dashboard's. */
  number: (value: number, options?: Intl.NumberFormatOptions) => string = formatNumber,
): string {
  const amount = amountMinor / 10 ** summary.decimalPlaces;
  const formatted = number(Math.abs(amount), {
    minimumFractionDigits: summary.decimalPlaces,
    maximumFractionDigits: summary.decimalPlaces,
  });
  return `${amount < 0 ? "-" : ""}${currencySymbol(summary.currencyCode)}${formatted}`;
}

export function formatSavedMajorAmount(
  amountMajor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
  number: (value: number, options?: Intl.NumberFormatOptions) => string = formatNumber,
): string {
  const factor = 10 ** summary.decimalPlaces;
  return formatSavedMinorAmount(Math.round(amountMajor * factor), summary, number);
}
