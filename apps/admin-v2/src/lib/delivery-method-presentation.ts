import {
  formatSavedMinorAmount,
  type SavedOrderMoneySummary,
} from "./order-tax-presentation";

export interface DeliveryMethodSnapshotFields {
  shippingMethodName?: string | null;
  shippingMethodDescription?: string | null;
  shippingMethodBaseAmountMinor?: number | null;
  shippingFeeWaived?: boolean | null;
}

export interface DeliveryMethodPresentation {
  label: string;
  details: string;
}

export function resolveDeliveryMethodPresentation(
  order: DeliveryMethodSnapshotFields,
  savedSummary: SavedOrderMoneySummary | null,
  fallbackLabel = "Delivery",
): DeliveryMethodPresentation {
  const methodName = order.shippingMethodName?.trim() || null;
  const methodDescription = order.shippingMethodDescription?.trim() || null;
  const baseAmount = savedSummary
    && Number.isSafeInteger(order.shippingMethodBaseAmountMinor)
    && Number(order.shippingMethodBaseAmountMinor) >= 0
    ? formatSavedMinorAmount(Number(order.shippingMethodBaseAmountMinor), savedSummary)
    : null;
  const waiverDetails = order.shippingFeeWaived === true
    ? baseAmount
      ? `Configured fee ${baseAmount} was waived.`
      : "Delivery fee was waived."
    : null;

  return {
    label: methodName ? `Delivery · ${methodName}` : fallbackLabel,
    details: [methodDescription, waiverDetails]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  };
}
