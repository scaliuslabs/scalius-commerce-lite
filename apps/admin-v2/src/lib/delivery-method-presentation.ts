import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { SavedOrderMoneySummary } from "@scalius/shared/order-money-presentation";
import { formatSavedMinorAmount } from "./order-money-format";

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

/** The delivery method saved on the order, including a waived fee. */
export function resolveDeliveryMethodPresentation(
  order: DeliveryMethodSnapshotFields,
  savedSummary: SavedOrderMoneySummary | null,
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
      ? translate(orderDetailMessages, "delivery.feeWaivedAmount", { amount: baseAmount })
      : translate(orderDetailMessages, "delivery.feeWaived")
    : null;

  return {
    label: methodName
      ? translate(orderDetailMessages, "delivery.method", { name: methodName })
      : translate(orderDetailMessages, "delivery.label"),
    details: [methodDescription, waiverDetails].filter(Boolean).join(" "),
  };
}
