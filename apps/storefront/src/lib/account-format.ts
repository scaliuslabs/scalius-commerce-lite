// Display rules shared by the account pages: one date format, one money format,
// one place order, one payment line and the buyer's words for open requests.

import { formatStoreDateTime, pageLanguage } from "./store-time-zone";
import { formatMoney } from "@/lib/currency";
import { shippingCountryName } from "@/lib/checkout/shipping-country";
import { getOrderPaymentPresentation } from "@/lib/order-success-state";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA, type CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { accountCopy } from "./account-copy";

export function accountMoney(amount: number, currencyCode?: string | null): string {
  return formatMoney(amount, currencyCode ? { code: currencyCode } : undefined);
}

type PaymentFacts = Parameters<typeof getOrderPaymentPresentation>[0] & { currencyCode?: string | null };

/**
 * How an order is paid and what, if anything, the buyer still owes, in the
 * checkout language's words (`copy`: the page's checkout language).
 */
export function orderPaymentLine(order: PaymentFacts, copy: CheckoutLanguageData = ENGLISH_CHECKOUT_LANGUAGE_DATA): {
  method: string;
  state: string;
  balanceDue: number;
  balanceLabel: string;
} {
  const payment = getOrderPaymentPresentation(order, copy);
  const state = !payment.isCod && !payment.isClosed && order.paymentStatus === "failed"
    ? accountCopy().format.paymentNeedsAttention
    : payment.balanceDue > 0
      ? `${accountMoney(payment.balanceDue, order.currencyCode)} ${payment.balanceLabel.toLowerCase()}`
      : payment.statusLabel;
  return { method: payment.methodLabel, state, balanceDue: payment.balanceDue, balanceLabel: payment.balanceLabel };
}

/** "Sep 24, 2026, 5:46 AM" in the store's time zone and country, or "Sep 24, 2026" without the time. */
export function formatAccountDate(
  iso: string | null | undefined,
  options: { time?: boolean; timeZone?: string } = {},
): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return formatStoreDateTime(date, pageLanguage(), options.time === false ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }, options.timeZone);
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

export function openRequestLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  const words = accountCopy().format;
  return type === "cancel_pre_shipment" ? words.cancellationRequested
    : type === "return" ? words.returnRequested
      : type === "refund" ? words.refundRequested
        : words.requestOpen;
}

/** Shown wherever a buyer-facing read cannot reach the store, in the page's language. */
export function accountOfflineMessage(): string {
  return accountCopy().shell.unavailable;
}

type Milestone = keyof ReturnType<typeof accountCopy>["tracking"]["milestones"];

/** The order status → where the order is, as the API maps it (core account-orders). */
const ORDER_STATUS_MILESTONE: Record<string, Milestone> = {
  pending: "placed",
  incomplete: "placed",
  confirmed: "confirmed",
  processing: "confirmed",
  shipped: "shipped",
  delivered: "delivered",
  completed: "delivered",
  cancelled: "cancelled",
  returned: "returned",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
};

function isMilestone(value: unknown): value is Milestone {
  return typeof value === "string" && value in accountCopy("en").tracking.milestones;
}

/** An order's one status word in the page's language ("On its way", "পথে আছে"). */
export function accountOrderStatusText(status: string): string {
  const words = accountCopy().tracking;
  if (status === "incomplete") return words.awaitingPayment;
  return words.milestones[ORDER_STATUS_MILESTONE[status] ?? "placed"];
}

/** A courier status in the page's language; booking and sync states read "Booked with courier". */
export function accountShipmentStatusText(status: string): string {
  const words = accountCopy().tracking;
  return (words.shipments as Record<string, string>)[status] ?? words.booked;
}

interface TrackingStep { key: string; label: string }
interface TrackingEvent { type: string; status: string; label: string; details?: string | null }

/**
 * The API's progress and dated updates, worded by their keys in the page's
 * language. Refund and request lines keep the API's words (they carry the
 * store's reasons).
 */
export function wordOrderTracking<P extends { steps: TrackingStep[]; outcome: TrackingStep | null }, E extends TrackingEvent>(
  progress: P | null | undefined,
  timeline: readonly E[],
  courier: string | null,
): { progress: P | null; timeline: E[] } {
  const words = accountCopy().tracking;
  const label = <T extends TrackingStep>(step: T): T => (isMilestone(step.key) ? { ...step, label: words.milestones[step.key] } : step);
  const details: Partial<Record<Milestone, string>> = {
    placed: words.placedDetails,
    confirmed: words.confirmedDetails,
    shipped: courier ? words.withCourier(courier) : words.shippedDetails,
  };
  return {
    progress: progress ? { ...progress, steps: progress.steps.map(label), outcome: progress.outcome ? label(progress.outcome) : null } : null,
    timeline: timeline.map((event) => {
      if (event.type === "order" && isMilestone(event.status)) {
        return { ...event, label: words.milestones[event.status], details: details[event.status] ?? null };
      }
      if (event.type === "payment" && (event.status === "confirmed" || event.status === "failed")) {
        return { ...event, label: event.status === "confirmed" ? words.paymentReceived : words.paymentFailed };
      }
      return event;
    }),
  };
}
