// What one orders-list row says, decided once for the table and the phone
// card. Every row has the same cells; these say what goes in them.
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { orderBadgeVisibility } from "~/components/admin/orderview/status-badges";
import type { OrderListMessageKey } from "~/i18n/order-list";
import { shipmentStatusLabel, type ShipmentStatusMessageKey } from "~/i18n/shipment-status";
import { deliveryMethodLabel, type OrderMessageKey } from "~/i18n/orders";

type Vars = Record<string, string | number>;
type ListT = (key: OrderListMessageKey, vars?: Vars) => string;
type OrderT = (key: OrderMessageKey, vars?: Vars) => string;
type ShipmentT = (key: ShipmentStatusMessageKey, vars?: Vars) => string;

export type RowTone = "critical" | "warning" | "neutral";

/** Something that holds the order up, in the merchant's words. */
export interface AttentionItem {
  tone: "critical" | "warning";
  text: string;
}

type AttentionOrder = Pick<OrderListItem, "onHold" | "paymentRecovery" | "activeRefundOperation" | "shipmentRecovery" | "openRequestType" | "refundDue" | "cod">;

/**
 * Everything that needs the merchant before the order can move on, most
 * urgent first: an app's hold for review, a failed online payment, a refund
 * or courier booking stuck mid-way, a customer request, money owed back, a
 * failed delivery. The row shows one marker for all of them (the Order
 * cell); the words are its label.
 */
export function orderAttention(order: AttentionOrder, t: ListT, o: OrderT): AttentionItem[] {
  const items: AttentionItem[] = [];
  // Nothing ships or moves on until staff release it.
  if (order.onHold) items.push({ tone: "critical", text: t("onHold") });
  const payment = order.paymentRecovery;
  const paymentState = payment?.state;
  if (paymentState && paymentState !== "none") {
    items.push({ tone: paymentState === "needs_attention" ? "critical" : "warning", text: t(`recovery.${paymentState}`) });
  }
  if (order.activeRefundOperation?.active) {
    items.push({ tone: order.activeRefundOperation.severity === "danger" ? "critical" : "warning", text: t("refundInProgress") });
  }
  if ((order.shipmentRecovery?.state ?? "none") !== "none") {
    items.push({ tone: order.shipmentRecovery!.severity === "danger" ? "critical" : "warning", text: t("courierCheck") });
  }
  if (order.cod?.status === "failed") {
    items.push({ tone: "critical", text: t("deliveryFailed", { count: order.cod.deliveryAttempts }) });
  }
  if (order.openRequestType) items.push({ tone: "warning", text: o(`request.${order.openRequestType}`) });
  if (order.refundDue > 0) items.push({ tone: "warning", text: o("refundOwed") });
  return items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "critical" ? -1 : 1));
}

const CRITICAL_SHIPMENT = new Set(["failed", "delivery_failed", "cancelled"]);

/**
 * The Delivery status cell: a courier booking to check, then what the order
 * page says (a returned order reads "Returned", a recorded failed cash attempt
 * "Delivery failed · attempt 1", never a stale "In transit"), then the
 * courier's status. Null before anything was booked or sent.
 */
export function deliveryStatus(
  order: Pick<OrderListItem, "status" | "cod" | "latestShipment" | "shipmentRecovery">,
  t: ListT,
  s: ShipmentT,
): { text: string; tone: RowTone } | null {
  const recovery = order.shipmentRecovery;
  if (recovery && (recovery.state ?? "none") !== "none") {
    return { text: t("courierCheck"), tone: recovery.severity === "danger" ? "critical" : "warning" };
  }
  if (order.status.toLowerCase() === "returned") return { text: s("shipment.returned"), tone: "warning" };
  if (order.cod?.status === "failed") return { text: t("deliveryFailed", { count: order.cod.deliveryAttempts }), tone: "critical" };
  const shipment = order.latestShipment;
  if (!shipment) return null;
  const status = shipment.status.toLowerCase();
  return {
    text: shipmentStatusLabel(s, status),
    tone: CRITICAL_SHIPMENT.has(status) ? "critical" : status === "returned" ? "warning" : "neutral",
  };
}

/**
 * The Delivery method cell: Pickup, No delivery (nothing physical), or the
 * courier of the latest parcel, else Delivery.
 */
export function deliveryMethod(
  order: Pick<OrderListItem, "shippingMethodKind" | "requiresShipping" | "latestShipment">,
  o: OrderT,
): string {
  if (order.shippingMethodKind === "pickup") return deliveryMethodLabel(o, "pickup");
  if (order.requiresShipping === false && !order.shippingMethodKind) return deliveryMethodLabel(o, "none");
  const courier = order.latestShipment?.providerName?.trim() || order.latestShipment?.providerType?.trim();
  return courier ? courier.charAt(0).toUpperCase() + courier.slice(1) : deliveryMethodLabel(o, "delivery");
}

/** The Fulfilment cell's badge: "Ready for pickup" once staff said so, else the fulfilment status. */
export function fulfilmentShown(
  order: Pick<OrderListItem, "status" | "fulfillmentStatus" | "shippingMethodKind" | "pickupReadyAt">,
): "readyForPickup" | string | null {
  if (!orderBadgeVisibility(order).fulfillment) return null;
  if (order.shippingMethodKind === "pickup" && order.fulfillmentStatus !== "complete" && order.pickupReadyAt) return "readyForPickup";
  return order.fulfillmentStatus;
}

/** The Payment cell's status, or null on a closed order (its status badge already tells the story). */
export function paymentShown(order: Pick<OrderListItem, "status" | "paymentStatus">): string | null {
  return orderBadgeVisibility(order).payment ? order.paymentStatus : null;
}

/** Cash the courier still has to collect for an open cash-on-delivery order, or 0. */
export function codToCollect(order: Pick<OrderListItem, "status" | "paymentMethod" | "paymentStatus" | "totalAmount" | "paidAmount">): number {
  if (order.paymentMethod !== "cod" || !orderBadgeVisibility(order).payment) return 0;
  if (order.paymentStatus !== "unpaid" && order.paymentStatus !== "partial") return 0;
  return Math.max(0, order.totalAmount - order.paidAmount);
}

/** What the order needs next, as far as the list can tell. */
export type OrderNextStep = "confirm" | "fulfil" | "collect" | "deliver";

/**
 * The one next step of a row, so a merchant always sees where an order goes
 * from the list (the order page's header offers the same step): confirm a new
 * order, fulfil a confirmed one, collect the cash of a cash order on its way,
 * mark a paid shipped order delivered. Nothing for a held, archived or
 * finished order.
 */
export function orderNextStep(
  order: Pick<OrderListItem, "status" | "fulfillmentStatus" | "paymentMethod" | "paymentStatus" | "totalAmount" | "paidAmount" | "archivedAt" | "onHold">,
): OrderNextStep | null {
  if (order.archivedAt || order.onHold) return null;
  const status = order.status.toLowerCase();
  if (status === "pending" || status === "processing") return "confirm";
  if (codToCollect(order) > 0 && ["confirmed", "shipped", "delivered"].includes(status)) return "collect";
  if (status === "confirmed" && order.fulfillmentStatus !== "complete") return "fulfil";
  if (status === "shipped" && order.paymentMethod !== "cod" && order.fulfillmentStatus === "complete" && order.paymentStatus === "paid") return "deliver";
  return null;
}

export const TONE_TEXT: Record<RowTone, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  neutral: "",
};
