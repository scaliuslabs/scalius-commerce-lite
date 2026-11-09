import { translate, type Locale } from "~/i18n";
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
  /** A document in another language (`useLocaleFormat`); absent: the dashboard's. */
  scope?: { locale: Locale; formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string },
): DeliveryMethodPresentation {
  const methodName = order.shippingMethodName?.trim() || null;
  const methodDescription = order.shippingMethodDescription?.trim() || null;
  const baseAmount = savedSummary
    && Number.isSafeInteger(order.shippingMethodBaseAmountMinor)
    && Number(order.shippingMethodBaseAmountMinor) >= 0
    ? formatSavedMinorAmount(Number(order.shippingMethodBaseAmountMinor), savedSummary, scope?.formatNumber)
    : null;
  const waiverDetails = order.shippingFeeWaived === true
    ? baseAmount
      ? translate(orderDetailMessages, "delivery.feeWaivedAmount", { amount: baseAmount }, scope?.locale)
      : translate(orderDetailMessages, "delivery.feeWaived", undefined, scope?.locale)
    : null;

  return {
    label: methodName
      ? translate(orderDetailMessages, "delivery.method", { name: methodName }, scope?.locale)
      : translate(orderDetailMessages, "delivery.label", undefined, scope?.locale),
    details: [methodDescription, waiverDetails].filter(Boolean).join(" "),
  };
}
