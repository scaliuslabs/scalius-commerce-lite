// Display rules shared by the account pages: one date format, one money format,
// one place order, one payment line and the buyer's words for open requests.

import { formatMoney } from "@/lib/currency";
import { shippingCountryName } from "@/lib/checkout/shipping-country";
import { getOrderPaymentPresentation } from "@/lib/order-success-state";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";

export function accountMoney(amount: number, currencyCode?: string | null): string {
  return formatMoney(amount, currencyCode ? { code: currencyCode } : undefined);
}

type PaymentFacts = Parameters<typeof getOrderPaymentPresentation>[0] & { currencyCode?: string | null };

/** How an order is paid and what, if anything, the buyer still owes. */
export function orderPaymentLine(order: PaymentFacts): {
  method: string;
  state: string;
  balanceDue: number;
  balanceLabel: string;
} {
  const payment = getOrderPaymentPresentation(order, ENGLISH_CHECKOUT_LANGUAGE_DATA);
  const state = !payment.isCod && !payment.isClosed && order.paymentStatus === "failed"
    ? "Payment needs attention"
    : payment.balanceDue > 0
      ? `${accountMoney(payment.balanceDue, order.currencyCode)} ${payment.balanceLabel.toLowerCase()}`
      : payment.statusLabel;
  return { method: payment.methodLabel, state, balanceDue: payment.balanceDue, balanceLabel: payment.balanceLabel };
}

const DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Dhaka",
});

/** "24 Sep 2026, 5:46 AM" in Bangladesh time, or "24 Sep 2026" without the time. */
export function formatAccountDate(iso: string | null | undefined, options: { time?: boolean } = {}): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const part = Object.fromEntries(DATE_PARTS.formatToParts(date).map(({ type, value }) => [type, value]));
  const day = `${part.day} ${part.month} ${part.year}`;
  return options.time === false ? day : `${day}, ${part.hour}:${part.minute} ${part.dayPeriod}`;
}

/** Area, zone, then city: "Mirpur 1, Mirpur, Dhaka". */
export function formatDeliveryArea(place: {
  areaName?: string | null;
  zoneName?: string | null;
  cityName?: string | null;
}): string {
  return [place.areaName, place.zoneName, place.cityName].filter(Boolean).join(", ");
}

/** A saved or shipped address as card lines: a Bangladesh one as always (line, then area, thana, city). */
export function formatAddressLines(address: {
  countryCode?: string | null;
  line1?: string | null;
  line2?: string | null;
  dependentLocality?: string | null;
  locality?: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
  areaName?: string | null;
  zoneName?: string | null;
  cityName?: string | null;
}, language = "en"): string[] {
  if (!address.countryCode || address.countryCode === "BD") {
    return [address.line1, address.line2, formatDeliveryArea(address)].filter((line): line is string => Boolean(line?.trim()));
  }
  return [
    address.line1,
    address.line2,
    [address.dependentLocality, address.locality].filter(Boolean).join(", "),
    [address.adminArea, address.postalCode].filter(Boolean).join(" "),
    shippingCountryName(address.countryCode, language),
  ].filter((line): line is string => Boolean(line?.trim()));
}

/** The order snapshot's places after its first line (Bangladesh: area, thana, city, as always). */
export interface OrderShippingPlaces {
  shippingCountryCode?: string | null;
  shippingAddressLine2?: string | null;
  shippingDependentLocality?: string | null;
  shippingLocality?: string | null;
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  areaName?: string | null;
  zoneName?: string | null;
  cityName?: string | null;
}

export function formatOrderPlaces(order: OrderShippingPlaces, language = "en"): string {
  if (!order.shippingCountryCode || order.shippingCountryCode === "BD") return formatDeliveryArea(order);
  return formatAddressLines({
    countryCode: order.shippingCountryCode,
    line2: order.shippingAddressLine2,
    dependentLocality: order.shippingDependentLocality,
    locality: order.shippingLocality,
    adminArea: order.shippingAdminArea,
    postalCode: order.shippingPostalCode,
  }, language).join(", ");
}

const OPEN_REQUEST_LABELS: Record<string, string> = {
  cancel_pre_shipment: "Cancellation requested",
  return: "Return requested",
  refund: "Refund requested",
};

export function openRequestLabel(type: string | null | undefined): string | null {
  return type ? OPEN_REQUEST_LABELS[type] ?? "Request open" : null;
}

/** Shown wherever a buyer-facing read cannot reach the store. */
export const ACCOUNT_OFFLINE_MESSAGE = "We couldn't reach the store. Check your connection and try again.";
