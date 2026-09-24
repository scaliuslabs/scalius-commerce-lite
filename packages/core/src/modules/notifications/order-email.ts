import type { Database } from "@scalius/database/client";
import { orders, orderItems } from "@scalius/database/schema";
import { formatMoney, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { asc, eq } from "drizzle-orm";
import { MESSAGE_COPY, requestCopy, type MessageLanguage } from "./message-copy";
import type { OrderNotificationType } from "./notification-types";
import {
  renderOrderEmail,
  renderTemplate,
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
  language: MessageLanguage;
  variables: NotificationVariableValues;
  facts: OrderEmailFacts;
}

// Read only persisted purchase facts, never today's catalog or an invoice issuance.
async function readOrderFacts(db: Database, orderId: string) {
  const rows = await db.select({ order: {
    customerName: orders.customerName,
    customerPhone: orders.customerPhone,
    shippingAddress: orders.shippingAddress,
    areaName: orders.areaName,
    zoneName: orders.zoneName,
    cityName: orders.cityName,
    shippingMethodName: orders.shippingMethodName,
    shippingMethodDescription: orders.shippingMethodDescription,
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
  }, item: {
    productName: orderItems.productName,
    variantLabel: orderItems.variantLabel,
    quantity: orderItems.quantity,
    unitPriceMinor: orderItems.unitPriceMinor,
    lineSubtotalMinor: orderItems.lineSubtotalMinor,
  } }).from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const order = rows[0]?.order;
  if (!order) throw new Error("Order email details are unavailable");
  return { order, items: rows.flatMap((row) => row.item ? [row.item] : []) };
}

const CLOSED_STATUSES = new Set(["cancelled", "returned", "refunded", "partially_refunded"]);

/** The order's facts and variable values in the store's language, for every channel. */
export async function readOrderMessageContext(input: OrderMessageInput, db: Database): Promise<OrderMessageContext> {
  const [{ order, items }, store] = await Promise.all([readOrderFacts(db, input.orderId), readStoreIdentity(db)]);
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
    language,
    variables: {
      customer_name: order.customerName?.trim() || input.name?.trim() || "",
      order_number: formatOrderNumber(order.orderNumber, input.orderId),
      order_total: money ? money(order.totalAmountMinor) : "",
      cod_amount: codDue ?? "",
      store_name: store.name ?? "",
      tracking_id: String(input.data?.trackingId ?? "").trim(),
      support_request: request,
      support_status: status,
    },
    facts: {
      store: { name: store.name, logoUrl: store.logoUrl },
      items: items.map((item) => ({
        name: item.productName?.trim() || null,
        variant: item.variantLabel?.trim() || null,
        quantity: item.quantity,
        unitPrice: money ? money(item.unitPriceMinor) : null,
        subtotal: money ? money(item.lineSubtotalMinor) : null,
      })),
      amounts: money ? {
        subtotal: money(order.subtotalAmountMinor),
        shipping: money(order.shippingAmountMinor),
        discount: order.discountAmountMinor > 0 ? money(order.discountAmountMinor) : null,
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
    subject: renderTemplate(template.subject, context.variables) || context.variables.order_number || "",
    body: renderTemplate(template.body, context.variables),
  });
  return { ...email, fromName: context.facts.store.name ?? undefined };
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
