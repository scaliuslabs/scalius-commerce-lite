// How an order's lines reach the buyer, in buyer words (Wave A §3.4, §8.2):
// the receipt, the account order page and the tracking status view group the
// lines by fulfilment type, say where each group is, show each line's buyer
// inputs, and replace the address with pickup facts or "No delivery needed".
// Pure: no DOM, no fetch. Properties are display-only here; they never go into
// URLs, analytics payloads, logs or data attributes.
import type { DeliveryMethodKind, FulfillmentType } from "@scalius/shared/fulfilment";
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import type { CustomerOrderProgress, CustomerOrderTimelineEvent } from "./api/customer-auth";
import type { OrderLineProperty, OrderPickup } from "./api/types";

/** Stable group order on every order page. */
export const ORDER_LINE_GROUP_ORDER = ["ship", "pickup", "service", "digital", "gift_card"] as const satisfies readonly FulfillmentType[];

export interface OrderLineGroupLine {
  /** Missing on pre-Wave-A lines: they shipped. */
  fulfillmentType?: FulfillmentType | null;
  quantity: number;
  /** Units handed over so far (sent, picked up, performed). */
  fulfilledQuantity?: number | null;
}

/** The order-level facts the grouping, the delivery block and the wording read. */
export interface OrderFulfilmentView {
  status: string;
  /** Some line ships to an address; undefined on pre-Wave-A orders (they shipped). */
  requiresShipping?: boolean;
  shippingMethodKind?: DeliveryMethodKind | null;
  pickup?: OrderPickup | null;
  shippingAddress?: string | null;
}

export interface OrderLineGroup<T extends OrderLineGroupLine> {
  type: FulfillmentType;
  heading: string;
  /** "Preparing", "Sent", "Ready for pickup"…; null for digital/gift cards and closed orders. */
  statusLabel: string | null;
  /** "1 of 3" while only some units are handed over; null otherwise. */
  progressLabel: string | null;
  items: T[];
}

const DONE_ORDER_STATUSES = new Set(["delivered", "completed"]);
/** No "Preparing" on an order that is not going anywhere. */
const NO_LINE_STATUS_ORDER_STATUSES = new Set(["incomplete", "failed", "cancelled", "refunded", "returned"]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function lineType(line: OrderLineGroupLine): FulfillmentType {
  const type = line.fulfillmentType;
  return type && (ORDER_LINE_GROUP_ORDER as readonly string[]).includes(type) ? type : "ship";
}

function wholeUnits(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function groupHeading(type: FulfillmentType, copy: CheckoutLanguageData): string {
  switch (type) {
    case "pickup": return copy.orderLineGroupPickupText;
    case "service": return copy.orderLineGroupServiceText;
    case "digital": return copy.orderLineGroupDigitalText;
    case "gift_card": return copy.orderLineGroupGiftCardText;
    default: return copy.orderLineGroupShipText;
  }
}

function groupStatus(
  type: FulfillmentType,
  counts: { done: number; total: number },
  order: OrderFulfilmentView,
  copy: CheckoutLanguageData,
): string | null {
  const status = normalize(order.status);
  if (NO_LINE_STATUS_ORDER_STATUSES.has(status)) return null;
  const orderDone = DONE_ORDER_STATUSES.has(status);
  const allHandedOver = counts.total > 0 && counts.done >= counts.total;
  switch (type) {
    case "ship":
      if (orderDone) return copy.orderLineDeliveredText;
      // Pre-ledger shipped orders carry no fulfilled units.
      return allHandedOver || status === "shipped" ? copy.orderLineSentText : copy.orderLinePreparingText;
    case "pickup":
      if (allHandedOver || orderDone) return copy.orderLinePickedUpText;
      return order.pickup?.readyAt ? copy.orderLineReadyForPickupText : copy.orderLinePreparingText;
    case "service":
      return allHandedOver || orderDone ? copy.orderLineServiceDoneText : copy.orderLinePreparingText;
    default:
      // Digital items and gift cards arrive on their own (Wave B).
      return null;
  }
}

/**
 * The order's lines grouped by how they reach the buyer, in the stable
 * ship → pickup → service → digital → gift card order, only groups with lines.
 * Lines keep their order inside a group.
 */
export function groupOrderLines<T extends OrderLineGroupLine>(
  items: readonly T[],
  order: OrderFulfilmentView,
  copy: CheckoutLanguageData,
): OrderLineGroup<T>[] {
  const byType = new Map<FulfillmentType, T[]>();
  for (const item of items) {
    const type = lineType(item);
    const lines = byType.get(type);
    if (lines) lines.push(item);
    else byType.set(type, [item]);
  }
  const closed = NO_LINE_STATUS_ORDER_STATUSES.has(normalize(order.status));
  return ORDER_LINE_GROUP_ORDER.flatMap((type) => {
    const lines = byType.get(type);
    if (!lines) return [];
    const total = lines.reduce((sum, line) => sum + wholeUnits(line.quantity), 0);
    const done = lines.reduce((sum, line) => sum + Math.min(wholeUnits(line.fulfilledQuantity), wholeUnits(line.quantity)), 0);
    const statusLabel = groupStatus(type, { done, total }, order, copy);
    const partial = done > 0 && done < total;
    return [{
      type,
      heading: groupHeading(type, copy),
      statusLabel,
      progressLabel: partial && statusLabel && !closed
        ? formatCheckoutLanguageText(copy.orderLineFulfilledCountText, { done, total })
        : null,
      items: lines,
    }];
  });
}

/**
 * One group that ships reads like today's receipt: no heading. Any other
 * single group (pickup, services…) or a mixed order gets headings.
 */
export function showsOrderLineGroupHeadings(groups: ReadonlyArray<{ type: FulfillmentType }>): boolean {
  return groups.length > 1 || (groups.length === 1 && groups[0]!.type !== "ship");
}

/** "Preparing · 1 of 3", "Ready for pickup", or "" for a heading-only group. */
export function orderLineGroupStatusText(group: { statusLabel: string | null; progressLabel: string | null }): string {
  return [group.statusLabel, group.progressLabel].filter(Boolean).join(" · ");
}

export interface OrderLinePropertyRow {
  label: string;
  value: string;
  /** "+৳200", only when the input costs extra per unit. */
  surcharge: string | null;
  /** "Engraving: Anika (+৳200)". */
  text: string;
}

/**
 * One row per buyer input under a line: `Label: value` plus `(+৳200)` when it
 * costs extra. `formatSurcharge` formats one property's per-unit surcharge in
 * the order currency (the page's own money formatter). Callers escape the text.
 */
export function orderLinePropertyRows(
  properties: readonly OrderLineProperty[] | null | undefined,
  formatSurcharge: (property: OrderLineProperty) => string,
  copy: CheckoutLanguageData,
): OrderLinePropertyRow[] {
  if (!Array.isArray(properties)) return [];
  return properties.flatMap((property) => {
    const label = (property?.label ?? "").trim();
    const value = (property?.displayValue ?? property?.value ?? "").trim();
    if (!label || !value) return [];
    const surcharge = Number(property.priceMinor) > 0
      ? formatCheckoutLanguageText(copy.customizationSurchargeText, { price: formatSurcharge(property) })
      : null;
    return [{ label, value, surcharge, text: `${label}: ${value}${surcharge ? ` (${surcharge})` : ""}` }];
  });
}

/** How the order reaches the buyer: to an address, picked up, or nothing to deliver. */
export type OrderDeliveryMode = "ship" | "pickup" | "none";

export function orderDeliveryMode(order: Omit<OrderFulfilmentView, "status">): OrderDeliveryMode {
  if (order.shippingMethodKind === "pickup") return "pickup";
  return order.requiresShipping === false ? "none" : "ship";
}

export type OrderDeliveryBlock =
  | { mode: "ship"; address: string | null }
  | {
      mode: "pickup";
      heading: string;
      /** "Pick up at …" / "Ready for pickup at …"; the plain ready word when the store gave no address. */
      location: string | null;
      hoursLabel: string;
      hours: string | null;
      /** "We'll let you know when…", until the store marks it ready. */
      notReady: string | null;
    }
  | { mode: "none"; text: string };

/** The "Ship to" block's replacement facts; never a "null" address line. */
export function resolveOrderDeliveryBlock(order: OrderFulfilmentView, copy: CheckoutLanguageData): OrderDeliveryBlock {
  const mode = orderDeliveryMode(order);
  if (mode === "none") return { mode, text: copy.orderNoDeliveryText };
  if (mode === "ship") return { mode, address: order.shippingAddress?.trim() || null };
  const address = order.pickup?.address?.trim() || null;
  const ready = Boolean(order.pickup?.readyAt);
  const collected = DONE_ORDER_STATUSES.has(normalize(order.status));
  const open = !NO_LINE_STATUS_ORDER_STATUSES.has(normalize(order.status));
  return {
    mode,
    heading: copy.orderPickupHeadingText,
    location: address
      ? formatCheckoutLanguageText(ready && !collected ? copy.orderPickupReadyText : copy.orderPickupAddressText, { address })
      : ready && !collected ? copy.orderLineReadyForPickupText : null,
    hoursLabel: copy.orderPickupHoursLabelText,
    hours: order.pickup?.hours?.trim() || null,
    notReady: !ready && !collected && open ? copy.orderPickupNotReadyText : null,
  };
}

/** The finished order's wording: "Picked up" for pickup, "Complete" when nothing was delivered. */
export interface OrderCompletionWording {
  statusLabel: string;
  title: string;
  /** Takes `{orderId}`. */
  messageTemplate: string;
}

export function orderCompletionWording(
  order: OrderFulfilmentView,
  copy: CheckoutLanguageData,
): OrderCompletionWording | null {
  if (!DONE_ORDER_STATUSES.has(normalize(order.status))) return null;
  const mode = orderDeliveryMode(order);
  if (mode === "pickup") {
    return {
      statusLabel: copy.orderLinePickedUpText,
      title: copy.orderLinePickedUpText,
      messageTemplate: copy.orderReceiptPickedUpMessageText,
    };
  }
  if (mode === "none") {
    return {
      statusLabel: copy.orderReceiptStatusCompletedText,
      title: copy.orderReceiptCompletedTitleText,
      messageTemplate: copy.orderReceiptFulfilledMessageText,
    };
  }
  return null;
}

/**
 * The step tracker in pickup or no-delivery words: "Ready for pickup" and
 * "Picked up" (or "Preparing" and "Completed") instead of "On its way" and
 * "Delivered". Shipping orders come back unchanged.
 */
export function relabelOrderProgress(
  progress: CustomerOrderProgress,
  order: OrderFulfilmentView,
  copy: CheckoutLanguageData,
): CustomerOrderProgress {
  const mode = orderDeliveryMode(order);
  if (mode === "ship") return progress;
  const readyAt = mode === "pickup" ? order.pickup?.readyAt ?? null : null;
  const confirmedDone = progress.steps.some((step) => step.key === "confirmed" && step.done);
  return {
    ...progress,
    steps: progress.steps.map((step) => {
      if (step.key === "delivered") {
        return { ...step, label: mode === "pickup" ? copy.orderLinePickedUpText : copy.orderReceiptStatusCompletedText };
      }
      if (step.key !== "shipped") return step;
      if (mode === "pickup") {
        return {
          ...step,
          label: copy.orderLineReadyForPickupText,
          done: step.done || Boolean(readyAt),
          happenedAt: step.happenedAt ?? readyAt,
        };
      }
      // Nothing travels: the third step is the store preparing it.
      return { ...step, label: copy.orderLinePreparingText, done: step.done || confirmedDone };
    }),
  };
}

/** Dated updates in the same words: "Picked up" / "Completed" instead of "Delivered". */
export function relabelOrderTimeline(
  timeline: readonly CustomerOrderTimelineEvent[],
  order: OrderFulfilmentView,
  copy: CheckoutLanguageData,
): CustomerOrderTimelineEvent[] {
  const mode = orderDeliveryMode(order);
  if (mode === "ship") return [...timeline];
  return timeline.map((event) => event.type === "order" && event.status === "delivered"
    ? { ...event, label: mode === "pickup" ? copy.orderLinePickedUpText : copy.orderReceiptStatusCompletedText }
    : event);
}

const REFUNDED_PAYMENT_STATUSES = new Set(["refunded", "partially_refunded"]);

/**
 * A receipt view with the finished order's pickup or no-delivery words: the
 * status badge always, the title and message when the view is the order's own
 * status (a refunded payment keeps its refund wording).
 */
export function withOrderCompletionWording<V extends { kind: string; title: string; message: string; orderStatusLabel: string }>(
  view: V,
  order: OrderFulfilmentView & { id: string; orderNumber?: number | null; paymentStatus?: string | null },
  copy: CheckoutLanguageData,
): V {
  const wording = orderCompletionWording(order, copy);
  if (!wording) return view;
  const ownStatusView = view.kind === "order_updated" && !REFUNDED_PAYMENT_STATUSES.has(normalize(order.paymentStatus));
  return {
    ...view,
    orderStatusLabel: wording.statusLabel,
    ...(ownStatusView
      ? {
          title: wording.title,
          // Copy templates already carry the "#": "Order #{orderId} has been picked up."
          message: formatCheckoutLanguageText(wording.messageTemplate, {
            orderId: formatOrderNumber(order.orderNumber, order.id).slice(1),
          }),
        }
      : {}),
  };
}
