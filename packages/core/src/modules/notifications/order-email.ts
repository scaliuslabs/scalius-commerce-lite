import type { Database } from "@scalius/database/client";
import { deliveryShipments, orderDiscountAllocations, orders, orderItems } from "@scalius/database/schema";
import { formatMoney, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { asc, desc, eq, sql } from "drizzle-orm";
import { getTrackingUrl } from "../delivery/tracking-url";
import { MESSAGE_COPY, requestCopy, type MessageLanguage } from "./message-copy";
import type { OrderNotificationType } from "./notification-types";
import {
  renderEmailTemplate,
  renderOrderEmail,
  renderSmsTemplate,
  type EmailPayment,
  type EmailTemplate,
  type NotificationVariableValues,
  type OrderEmailFacts,
} from "./notification-templates";
import { readStoreIdentity } from "./store-messages";

export interface OrderMessageInput {
  orderId: string;
  type: OrderNotificationType;
  /** The queued name; the saved order's customer name wins when present. */
  name?: string;
  data?: Record<string, unknown>;
  storefrontUrl?: string;
}

/** Everything a customer or staff message can say about one order. */
export interface OrderMessageContext {
  event: OrderNotificationType;
  language: MessageLanguage;
  variables: NotificationVariableValues;
  facts: OrderEmailFacts;
}

// Read only persisted purchase facts, never today's catalog or an invoice issuance.
async function readOrderFacts(db: Database, orderId: string) {
  const rows = db.select({ order: {
    customerName: orders.customerName,
    customerPhone: orders.customerPhone,
    shippingAddress: orders.shippingAddress,
    areaName: orders.areaName,
    zoneName: orders.zoneName,
    cityName: orders.cityName,
    shippingMethodName: orders.shippingMethodName,
    shippingMethodDescription: orders.shippingMethodDescription,
    shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
    shippingFeeWaived: orders.shippingFeeWaived,
    accountOwnerCustomerId: orders.accountOwnerCustomerId,
    orderNumber: orders.orderNumber,
    status: orders.status,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    balanceDueMinor: orders.balanceDueMinor,
    currencyCode: orders.currencyCode,
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
    subtotalAmountMinor: orders.subtotalAmountMinor,
    shippingAmountMinor: orders.shippingAmountMinor,
    discountAmountMinor: orders.discountAmountMinor,
    taxAmountMinor: orders.taxAmountMinor,
    totalAmountMinor: orders.totalAmountMinor,
    taxLabel: orders.taxLabel,
    pricesIncludeTax: orders.pricesIncludeTax,
    pickupAddress: orders.pickupAddress,
    pickupHours: orders.pickupHours,
  }, item: {
    productName: orderItems.productName,
    variantLabel: orderItems.variantLabel,
    quantity: orderItems.quantity,
    unitPriceMinor: orderItems.unitPriceMinor,
    lineSubtotalMinor: orderItems.lineSubtotalMinor,
    properties: orderItems.properties,
  } }).from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  // The immutable per-promotion allocations the order was placed with.
  const discounts = db.select({
    promotionId: orderDiscountAllocations.promotionId,
    name: orderDiscountAllocations.promotionName,
    code: orderDiscountAllocations.promotionCode,
    target: orderDiscountAllocations.target,
    amountMinor: sql<number>`SUM(${orderDiscountAllocations.discountAmountMinor})`,
  }).from(orderDiscountAllocations)
    .where(eq(orderDiscountAllocations.orderId, orderId))
    .groupBy(
      orderDiscountAllocations.promotionId,
      orderDiscountAllocations.promotionName,
      orderDiscountAllocations.promotionCode,
      orderDiscountAllocations.target,
    )
    .orderBy(asc(orderDiscountAllocations.promotionName));
  const [orderRows, discountRows] = await Promise.all([rows, discounts]);
  const order = orderRows[0]?.order;
  if (!order) throw new Error("Order email details are unavailable");
  return {
    order,
    items: orderRows.flatMap((row) => row.item ? [row.item] : []),
    discounts: discountRows.map((row) => ({ ...row, amountMinor: Number(row.amountMinor) || 0 })),
  };
}

type OrderFacts = Awaited<ReturnType<typeof readOrderFacts>>;

/**
 * The line's frozen buyer inputs as "Engraving: Anika (+৳200)", read from the
 * immutable `order_items.properties` snapshot. Plain text: the email template
 * escapes it. Emails only; SMS variables never carry buyer inputs.
 */
function linePropertiesText(stored: string | null, money: ((minor: number) => string) | null): string[] {
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const { label, value, displayValue, priceMinor } = entry as Record<string, unknown>;
    const shown = typeof displayValue === "string" ? displayValue : typeof value === "string" ? value : null;
    if (typeof label !== "string" || shown === null) return [];
    const surcharge = money && typeof priceMinor === "number" && Number.isSafeInteger(priceMinor) && priceMinor > 0
      ? ` (+${money(priceMinor)})`
      : "";
    return [`${label}: ${shown}${surcharge}`];
  });
}

/**
 * The summary's discount and delivery lines: each promotion by name and code,
 * and delivery as the buyer pays it with the fee a waiver or a shipping
 * discount replaced. Allocations that don't add up to the saved discount fall
 * back to one "Discount" line so the summary always matches the total.
 */
function discountAndDelivery({ order, discounts }: OrderFacts, money: (minor: number) => string) {
  const shippingDiscountMinor = discounts.filter((row) => row.target === "shipping")
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const promotions = new Map<string, { name: string; code: string | null; minor: number }>();
  for (const row of discounts) {
    if (row.target === "shipping") continue;
    const promotion = promotions.get(row.promotionId);
    if (promotion) promotion.minor += row.amountMinor;
    else promotions.set(row.promotionId, { name: row.name, code: row.code, minor: row.amountMinor });
  }
  const allocatedMinor = [...promotions.values()].reduce((sum, row) => sum + row.minor, 0) + shippingDiscountMinor;
  const fits = allocatedMinor <= order.discountAmountMinor && shippingDiscountMinor <= order.shippingAmountMinor;
  const lines: Array<{ name: string | null; code: string | null; amount: string }> = fits
    ? [...promotions.values()].filter((row) => row.minor > 0)
      .map((row) => ({ name: row.name, code: row.code, amount: money(row.minor) }))
    : [];
  const otherMinor = order.discountAmountMinor - (fits ? allocatedMinor : 0);
  if (otherMinor > 0) lines.push({ name: null, code: null, amount: money(otherMinor) });

  let charged = order.shippingAmountMinor;
  let original: number | null = null;
  if (fits && shippingDiscountMinor > 0) {
    original = charged;
    charged -= shippingDiscountMinor;
  } else if (order.shippingFeeWaived && charged === 0 && (order.shippingMethodBaseAmountMinor ?? 0) > 0) {
    original = order.shippingMethodBaseAmountMinor;
  }
  return {
    discounts: lines,
    delivery: {
      amount: charged > 0 ? money(charged) : null,
      original: original !== null && original > charged ? money(original) : null,
    },
  };
}

/** The refund in this message (major units in the queued facts), in the order's currency. */
function refundAmount(amount: unknown, currency: string | null): string {
  const value = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : Number.NaN;
  return currency && Number.isFinite(value) && value > 0 ? formatMoney(value, { code: currency }) : "";
}

const CLOSED_STATUSES = new Set(["cancelled", "returned", "refunded", "partially_refunded"]);

/** The order's facts and variable values in the store's language, for every channel. */
/** The parcel a shipped message is about: the one with the queued tracking ID, else the newest. */
async function readShipment(db: Database, orderId: string, trackingId: string) {
  const shipments = await db.select({
    providerType: deliveryShipments.providerType,
    trackingId: deliveryShipments.trackingId,
    trackingUrl: deliveryShipments.trackingUrl,
    courierName: deliveryShipments.courierName,
  }).from(deliveryShipments)
    .where(eq(deliveryShipments.orderId, orderId))
    .orderBy(desc(deliveryShipments.createdAt), desc(deliveryShipments.id))
    .limit(10);
  const shipment = shipments.find((row) => trackingId && row.trackingId === trackingId) ?? shipments[0];
  if (!shipment) return null;
  const tracking = trackingId || shipment.trackingId?.trim() || "";
  const url = shipment.trackingUrl?.trim() || getTrackingUrl(shipment.providerType, tracking || null) || "";
  return {
    trackingId: tracking,
    courierName: shipment.courierName?.trim() || COURIER_NAMES[shipment.providerType] || "",
    // Only a public http(s) page may become a link in the message.
    trackingUrl: /^https?:\/\/[^\s]+$/.test(url) ? url : "",
  };
}

const COURIER_NAMES: Record<string, string> = { pathao: "Pathao", steadfast: "Steadfast" };

export async function readOrderMessageContext(input: OrderMessageInput, db: Database): Promise<OrderMessageContext> {
  const queuedTrackingId = String(input.data?.trackingId ?? "").trim();
  const [facts, store, shipment] = await Promise.all([
    readOrderFacts(db, input.orderId),
    readStoreIdentity(db),
    input.type === "order_shipped" ? readShipment(db, input.orderId, queuedTrackingId) : null,
  ]);
  const { order, items } = facts;
  const { language } = store;

  const currency = normalizeSupportedCurrencyCode(order.currencyCode);
  const decimals = order.currencyDecimalPlaces;
  const money = currency && Number.isInteger(decimals) && decimals >= 0 && decimals <= 3
    ? (minor: number) => formatMoney(fromMinor(minor, decimals), { code: currency })
    : null;

  let payment: EmailPayment;
  if (order.paymentStatus === "refunded" || order.status === "refunded") payment = { state: "refunded" };
  else if (order.paymentStatus === "partially_refunded" || order.status === "partially_refunded") payment = { state: "partially_refunded" };
  else if (CLOSED_STATUSES.has(order.status)) payment = { state: "nothing_due" };
  else if (order.paymentStatus === "paid") payment = { state: "paid" };
  else if (order.paymentMethod === "cod") {
    payment = { state: "cod", due: money ? money(Math.max(0, order.balanceDueMinor)) : null, partiallyPaid: order.paymentStatus === "partial" };
  } else payment = { state: order.paymentStatus === "partial" ? "partially_paid" : "not_completed" };

  // Account orders open in the account; guests verify on the public order page.
  // Phone and email never go into these URLs.
  const origin = normalizeStorefrontOrigin(input.storefrontUrl);
  const orderLink = !origin ? null : order.accountOwnerCustomerId
    ? { kind: "account" as const, href: `${origin}/account/orders/${encodeURIComponent(input.orderId)}` }
    : { kind: "track" as const, href: `${origin}/track-order?order=${encodeURIComponent(String(order.orderNumber ?? input.orderId))}` };

  const support: Array<{ label: string; href: string }> = [];
  const email = store.business.email.trim();
  const phone = store.business.phone.trim();
  if (email && /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(email)) {
    support.push({ label: email, href: `mailto:${encodeURIComponent(email)}` });
  }
  if (phone && /^\+?[\d][\d ()-]{5,24}$/.test(phone)) {
    support.push({ label: phone, href: `tel:${phone.replace(/[ ()-]/g, "")}` });
  }

  const { request, status } = requestCopy(MESSAGE_COPY[language], input.data?.supportRequestType, input.data?.supportRequestStatus);
  const codDue = payment.state === "cod" ? payment.due : null;
  return {
    event: input.type,
    language,
    variables: {
      customer_name: order.customerName?.trim() || input.name?.trim() || "",
      order_number: formatOrderNumber(order.orderNumber, input.orderId),
      order_total: money ? money(order.totalAmountMinor) : "",
      cod_amount: codDue ?? "",
      store_name: store.name ?? "",
      tracking_id: shipment?.trackingId ?? queuedTrackingId,
      courier_name: shipment?.courierName ?? "",
      tracking_url: shipment?.trackingUrl ?? "",
      refund_amount: refundAmount(input.data?.amount, currency),
      support_request: request,
      support_status: status,
      pickup_address: order.pickupAddress?.trim() ?? "",
      pickup_hours: order.pickupHours?.trim() ?? "",
    },
    facts: {
      store: { name: store.name, logoUrl: store.logoUrl },
      items: items.map((item) => ({
        name: item.productName?.trim() || null,
        variant: item.variantLabel?.trim() || null,
        quantity: item.quantity,
        unitPrice: money ? money(item.unitPriceMinor) : null,
        subtotal: money ? money(item.lineSubtotalMinor) : null,
        properties: linePropertiesText(item.properties, money),
      })),
      amounts: money ? {
        subtotal: money(order.subtotalAmountMinor),
        ...discountAndDelivery(facts, money),
        tax: order.taxAmountMinor > 0
          ? { label: order.taxLabel, amount: money(order.taxAmountMinor), included: Boolean(order.pricesIncludeTax) }
          : null,
        total: money(order.totalAmountMinor),
      } : null,
      payment,
      address: [
        order.customerName,
        order.customerPhone ? formatBdMobile(order.customerPhone) : null,
        order.shippingAddress,
        [order.areaName, order.zoneName, order.cityName].map((part) => part?.trim()).filter(Boolean).join(", "),
      ].map((line) => line?.trim()).filter((line): line is string => Boolean(line)),
      method: [order.shippingMethodName, order.shippingMethodDescription]
        .map((line) => line?.trim()).filter((line): line is string => Boolean(line)),
      origin,
      orderLink,
      support,
    },
  };
}

/** Called only after the email target is eligible (and its receipt is claimed). */
export function composeOrderEmail(context: OrderMessageContext, template: EmailTemplate) {
  const email = renderOrderEmail({
    language: context.language,
    facts: context.facts,
    ...renderEmailTemplate(context.event, context.language, template, context.variables),
  });
  return { ...email, fromName: context.facts.store.name ?? undefined };
}

/** The customer's SMS for this order event, from the merchant's template. */
export function composeOrderSms(context: OrderMessageContext, body: string): string {
  return renderSmsTemplate(context.event, context.language, body, context.variables);
}

/** The staff "new order" email: the same order facts, linked to the dashboard. */
export function composeStaffOrderEmail(context: OrderMessageContext, dashboardOrderUrl: string | null) {
  const copy = MESSAGE_COPY[context.language].staffOrder;
  const { customer_name: customer = "", order_number: order = "", order_total: total = "" } = context.variables;
  const email = renderOrderEmail({
    language: context.language,
    // Staff never get the buyer's links or the store's own support contacts.
    facts: { ...context.facts, origin: null, orderLink: null, support: [] },
    subject: copy.subject(context.facts.store.name, order, customer),
    body: copy.body(customer, order, total),
    action: dashboardOrderUrl ? { label: copy.action, href: dashboardOrderUrl } : undefined,
  });
  return { ...email, fromName: context.facts.store.name ?? undefined };
}
