import { formatMoney } from "@/lib/currency";
import type { SavedOrderMoneySummary } from "@scalius/shared/order-money-presentation";

export function formatSavedMinorAmount(
  amountMinor: number,
  summary: Pick<SavedOrderMoneySummary, "currencyCode" | "decimalPlaces">,
): string {
  return formatMoney(amountMinor / 10 ** summary.decimalPlaces, { code: summary.currencyCode });
}
