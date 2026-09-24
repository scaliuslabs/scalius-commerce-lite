import type { Database } from "@scalius/database/client";
import { orders, orderItems } from "@scalius/database/schema";
import { formatPrice, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { getBusinessSettings } from "../settings/business-settings.service";
import type { OrderNotificationType } from "./notification-types";
import {
  formatOrderNumber,
  renderOrderEmail,
  renderTemplate,
  type EmailTemplate,
  type NotificationVariableValues,
  type OrderEmailView,
} from "./notification-templates";

export interface OrderMessageInput {
  orderId: string;
  name: string;
  type: OrderNotificationType;
  data?: Record<string, unknown>;
  storefrontUrl?: string;
}

/** Everything a customer message can say about one order. */
export interface OrderMessageContext {
  variables: NotificationVariableValues;
  email: Omit<OrderEmailView, "subject" | "body">;
}

// Orders gain a per-store number in slice F4; until this schema declares the
// column the number reads as null and messages show the short order id.
const orderNumberColumn: SQL<number | null> =
  ((orders as unknown as { orderNumber?: SQL<number | null> }).orderNumber) ?? sql<number | null>`null`;

// Read only persisted purchase facts, never today's catalog or an invoice issuance.
async function readOrderFacts(db: Database, orderId: string) {
  const rows = await db.select({ order: {
    orderNumber: orderNumberColumn,
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
  const items = rows.flatMap((row) => row.item ? [row.item] : []);
  const business = await getBusinessSettings(db);
  return { order, items, business };
}

/** Store name for customer messages and the email sender name. */
export function storeDisplayName(business: { companyName: string; legalName: string } | null | undefined): string {
  return business?.companyName.trim() || business?.legalName.trim() || "";
}

/** BDT as buyers read it: ৳ with lakh grouping, whole taka without decimals. */
function moneyFormatter(currencyCode: string | null | undefined, decimals: number) {
  const currency = normalizeSupportedCurrencyCode(currencyCode);
  if (!currency || !Number.isInteger(decimals) || decimals < 0 || decimals > 3) return null;
  if (currency === "BDT") {
    return (minor: number) => {
      const amount = fromMinor(minor, decimals);
      const whole = Number.isInteger(amount);
      return `৳${new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
      }).format(amount)}`;
    };
  }
  return (minor: number) =>
    formatPrice(fromMinor(minor, decimals), { symbol: `${currency} `, code: currency, precision: decimals });
}

/**
 * The order facts and variable values for one customer message. Without a
 * database (legacy direct dispatch) only the caller's facts are known.
 */
export async function readOrderMessageContext(
  input: OrderMessageInput,
  db?: Database,
): Promise<OrderMessageContext> {
  const facts = db ? await readOrderFacts(db, input.orderId) : null;
  const order = facts?.order;
  const storeName = storeDisplayName(facts?.business);
  const money = order ? moneyFormatter(order.currencyCode, order.currencyDecimalPlaces ?? 0) : null;

  const summary: Array<[string, string]> = [];
  if (order && money) {
    summary.push(["Subtotal", money(order.subtotalAmountMinor)], ["Shipping", money(order.shippingAmountMinor)]);
    if (order.discountAmountMinor > 0) summary.push(["Discount", `−${money(order.discountAmountMinor)}`]);
    if (order.taxAmountMinor > 0) summary.push([`${order.taxLabel || "Tax"}${order.pricesIncludeTax ? " (included)" : ""}`, money(order.taxAmountMinor)]);
    summary.push(["Total", money(order.totalAmountMinor)]);
  }

  let payment = "";
  let codDue: number | null = null;
  if (order) {
    const closed = ["cancelled", "returned", "refunded", "partially_refunded"].includes(order.status);
    if (order.paymentStatus === "refunded" || order.status === "refunded") payment = "Refunded. No payment is due.";
    else if (order.status === "partially_refunded") payment = "Partially refunded. No payment is due for this closed order.";
    else if (closed) payment = "No payment is due for this closed order.";
    else if (order.paymentStatus === "paid") payment = "Paid";
    else if (order.paymentMethod === "cod") {
      codDue = Math.max(0, order.balanceDueMinor);
      const due = money ? `${money(codDue)} due on delivery.` : "Payment is due on delivery.";
      payment = `${order.paymentStatus === "partial" ? "Partially paid. " : "Cash on delivery. "}${due}`;
    } else payment = order.paymentStatus === "partial" ? "Partially paid" : "Payment not completed";
  }

  const items = facts?.items.map((item) => ({
    name: item.productName?.trim() || "Item name unavailable",
    variant: item.variantLabel?.trim(),
    quantity: money ? `${item.quantity} × ${money(item.unitPriceMinor)}` : `Quantity: ${item.quantity}`,
    subtotal: money ? money(item.lineSubtotalMinor) : "",
  })) ?? [];

  const support: Array<{ label: string; href: string }> = [];
  const email = facts?.business.email.trim();
  const phone = facts?.business.phone.trim();
  if (email && /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(email)) {
    support.push({ label: email, href: `mailto:${encodeURIComponent(email)}` });
  }
  if (phone && /^\+?[\d][\d ()-]{5,24}$/.test(phone)) {
    support.push({ label: phone, href: `tel:${phone.replace(/[ ()-]/g, "")}` });
  }

  const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));
  return {
    variables: {
      customer_name: input.name,
      order_number: formatOrderNumber(order?.orderNumber, input.orderId),
      order_total: order && money ? money(order.totalAmountMinor) : "",
      cod_amount: codDue !== null && money ? money(codDue) : money ? money(0) : "",
      store_name: storeName,
      tracking_id: text(input.data?.trackingId),
      support_request: text(input.data?.supportRequestTypeLabel) || "support request",
      support_status: text(input.data?.supportRequestStatusLabel) || "updated",
    },
    email: {
      storeName,
      items,
      summary,
      amountsUnavailable: Boolean(order && !money),
      payment,
      origin: normalizeStorefrontOrigin(input.storefrontUrl),
      support,
    },
  };
}

/** Called only after the email target is eligible (and its receipt is claimed). */
export function composeOrderEmail(context: OrderMessageContext, template: EmailTemplate) {
  return renderOrderEmail({
    ...context.email,
    subject: renderTemplate(template.subject, context.variables) || `Order ${context.variables.order_number}`,
    body: renderTemplate(template.body, context.variables),
  });
}

/** The staff "new order" email: the same order facts, linked to the dashboard. */
export function composeStaffOrderEmail(context: OrderMessageContext, dashboardOrderUrl: string | null) {
  const { customer_name: customer, order_number: number, order_total: total } = context.variables;
  const store = context.email.storeName;
  return renderOrderEmail({
    ...context.email,
    subject: `${store ? `[${store}] ` : ""}Order ${number} placed by ${customer}`,
    body: `${customer} placed order ${number}${total ? ` for ${total}` : ""}.`,
    origin: null,
    support: [],
    action: dashboardOrderUrl ? { label: "View order", href: dashboardOrderUrl } : undefined,
  });
}
