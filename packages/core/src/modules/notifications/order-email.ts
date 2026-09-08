import type { Database } from "@scalius/database/client";
import { orders, orderItems } from "@scalius/database/schema";
import { formatPrice, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { escapeHtml } from "@scalius/shared/html-escape";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { asc, eq } from "drizzle-orm";
import { getBusinessSettings } from "../settings/business-settings.service";
import type { OrderNotificationType } from "./notification-types";

interface OrderEmailInput {
  orderId: string;
  name: string;
  type: OrderNotificationType;
  data?: Record<string, unknown>;
  storefrontUrl?: string;
}

// Read only persisted purchase facts, never today's catalog or an invoice issuance.
async function readOrderEmailContext(db: Database, orderId: string) {
  const rows = await db.select({ order: {
    status: orders.status,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    balanceDue: orders.balanceDue,
    currencyCode: orders.currencyCode,
    currencyDecimalPlaces: orders.currencyDecimalPlaces,
    subtotalAmountMinor: orders.subtotalAmountMinor,
    shippingAmountMinor: orders.shippingAmountMinor,
    discountAmountMinor: orders.discountAmountMinor,
    taxAmountMinor: orders.taxAmountMinor,
    totalAmountMinor: orders.totalAmountMinor,
    totalAmount: orders.totalAmount,
    shippingCharge: orders.shippingCharge,
    discountAmount: orders.discountAmount,
    taxLabel: orders.taxLabel,
    pricesIncludeTax: orders.pricesIncludeTax,
  }, item: {
    productName: orderItems.productName,
    variantLabel: orderItems.variantLabel,
    quantity: orderItems.quantity,
    price: orderItems.price,
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

const SUBJECTS: Record<OrderNotificationType, string> = {
  order_created: "Received",
  order_confirmed: "Confirmed",
  order_processing: "Processing",
  order_shipped: "Shipped",
  order_delivered: "Delivered",
  order_completed: "Completed",
  order_cancelled: "Cancelled",
  order_returned: "Returned",
  refund_processing: "Refund Processing",
  refund_failed: "Refund Failed",
  order_refunded: "Refunded",
  order_partially_refunded: "Partially Refunded",
  payment_balance_paid: "Balance Paid",
  support_request_submitted: "Support Request Submitted",
  support_request_status_updated: "Support Request Updated",
};

/** Called only after the email target is eligible (and its receipt is claimed). */
export async function composeOrderEmail(input: OrderEmailInput, db?: Database) {
  const context = db ? await readOrderEmailContext(db, input.orderId) : null;
  const order = context?.order;
  const business = context?.business;
  const companyName = business?.companyName.trim() || business?.legalName.trim();
  const origin = normalizeStorefrontOrigin(input.storefrontUrl);
  const subject = `Order #${input.orderId} ${SUBJECTS[input.type]}`.replace(/[\r\n]+/g, " ");
  const messages: Record<OrderNotificationType, string> = {
    order_created: "Thank you for your order. We've received it and will update you as it progresses.",
    order_confirmed: "Your order has been confirmed and is being prepared.",
    order_processing: "Your order is being processed. We'll update you when it ships.",
    order_shipped: `Your order is on its way.${input.data?.trackingId ? ` Tracking ID: ${String(input.data.trackingId)}` : ""}`,
    order_delivered: "Your order has been delivered. Thank you for shopping with us.",
    order_completed: "Your order has been completed. Thank you for shopping with us.",
    order_cancelled: "Your order has been cancelled.",
    order_returned: "Your order has been marked as returned.",
    refund_processing: "Your refund for this order is being processed. We'll update you when it is complete.",
    refund_failed: "We couldn't complete the refund for this order. Please contact support for help.",
    order_refunded: "A refund has been processed for this order.",
    order_partially_refunded: "A partial refund has been processed for this order.",
    payment_balance_paid: "We've received the remaining payment for this order.",
    support_request_submitted: `We've received your ${String(input.data?.supportRequestTypeLabel ?? "support request")}. The merchant will review it and update you soon.`,
    support_request_status_updated: `Your ${String(input.data?.supportRequestTypeLabel ?? "support request")} is now ${String(input.data?.supportRequestStatusLabel ?? "updated")}.`,
  };
  const message = messages[input.type];
  const currency = normalizeSupportedCurrencyCode(order?.currencyCode);
  const decimals = order?.currencyDecimalPlaces;
  const hasCurrency = Boolean(currency) && decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 3;
  const factor = hasCurrency ? 10 ** decimals! : 1;
  const money = (major: number) => formatPrice(major, { symbol: `${currency} `, code: currency!, precision: decimals! });
  const amount = (minor: number | null, major: number) => money(minor == null ? major : minor / factor);
  const summary: Array<[string, string]> = [];
  if (order && hasCurrency) {
    const tax = order.taxAmountMinor / factor;
    summary.push(
      ["Subtotal", amount(order.subtotalAmountMinor, order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0) - (order.pricesIncludeTax ? 0 : tax))],
      ["Shipping", amount(order.shippingAmountMinor, order.shippingCharge)],
    );
    if ((order.discountAmountMinor ?? order.discountAmount ?? 0) > 0) {
      summary.push(["Discount", `−${amount(order.discountAmountMinor, order.discountAmount ?? 0)}`]);
    }
    if (order.taxAmountMinor > 0) summary.push([`${order.taxLabel || "Tax"}${order.pricesIncludeTax ? " (included)" : ""}`, money(tax)]);
    summary.push(["Total", amount(order.totalAmountMinor, order.totalAmount)]);
  }

  let payment = "";
  if (order) {
    const closed = ["cancelled", "returned", "refunded", "partially_refunded"].includes(order.status);
    if (order.paymentStatus === "refunded" || order.status === "refunded") payment = "Refunded. No payment is due.";
    else if (order.status === "partially_refunded") payment = "Partially refunded. No payment is due for this closed order.";
    else if (closed) payment = "No payment is due for this closed order.";
    else if (order.paymentStatus === "paid") payment = "Paid";
    else if (order.paymentMethod === "cod") {
      const due = hasCurrency ? `${money(Math.max(0, order.balanceDue))} due on delivery.` : "Payment is due on delivery.";
      payment = `${order.paymentStatus === "partial" ? "Partially paid. " : "Cash on delivery. "}${due}`;
    } else payment = order.paymentStatus === "partial" ? "Partially paid" : "Payment not completed";
  }

  const items = context?.items.map((item) => ({
    name: item.productName?.trim() || "Item name unavailable",
    variant: item.variantLabel?.trim(),
    quantity: hasCurrency ? `${item.quantity} × ${amount(item.unitPriceMinor, item.price)}` : `Quantity: ${item.quantity}`,
    subtotal: hasCurrency ? amount(item.lineSubtotalMinor, (item.unitPriceMinor == null ? item.price : item.unitPriceMinor / factor) * item.quantity) : "",
  })) ?? [];
  const support: Array<{ label: string; href: string }> = [];
  const email = business?.email.trim();
  const phone = business?.phone.trim();
  if (email && /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(email)) {
    support.push({ label: email, href: `mailto:${encodeURIComponent(email)}` });
  }
  if (phone && /^\+?[\d][\d ()-]{5,24}$/.test(phone)) {
    support.push({ label: phone, href: `tel:${phone.replace(/[ ()-]/g, "")}` });
  }
  const text = [
    companyName, subject, `Hi ${input.name},`, message,
    ...items.map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}\n${item.quantity}${item.subtotal ? ` — ${item.subtotal}` : ""}`),
    ...summary.map(([label, value]) => `${label}: ${value}`),
    order && !hasCurrency ? "Order amounts are unavailable in this email." : "",
    payment ? `Payment: ${payment}` : "",
    origin ? `View your account: ${origin}/account\nVisit store: ${origin}/` : "",
    support.length ? `Need help?\n${support.map((contact) => contact.label).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${companyName ? `<p style="margin:0 0 20px;font-size:18px;font-weight:600;">${escapeHtml(companyName)}</p>` : ""}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${escapeHtml(subject)}</h1>
<p style="margin:0 0 8px;">Hi ${escapeHtml(input.name)},</p><p style="margin:0 0 24px;">${escapeHtml(message)}</p>
${items.length ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr><th scope="col" style="text-align:left;padding:0 8px 8px 0;border-bottom:1px solid #dadce0;">Items</th><th scope="col" style="width:34%;text-align:right;padding:0 0 8px;border-bottom:1px solid #dadce0;">${hasCurrency ? "Subtotal" : ""}</th></tr></thead><tbody>${items.map((item) => `<tr><td style="padding:12px 8px 12px 0;vertical-align:top;border-bottom:1px solid #dadce0;"><strong>${escapeHtml(item.name)}</strong>${item.variant ? `<div style="color:#5f6368;">${escapeHtml(item.variant)}</div>` : ""}<div style="font-size:14px;color:#5f6368;">${escapeHtml(item.quantity)}</div></td><td style="padding:12px 0;vertical-align:top;text-align:right;border-bottom:1px solid #dadce0;">${escapeHtml(item.subtotal)}</td></tr>`).join("")}</tbody></table>` : ""}
${summary.length ? `<table aria-label="Order amounts" style="width:100%;border-collapse:collapse;margin:16px 0;">${summary.map(([label, value]) => `<tr><th scope="row" style="padding:4px 12px 4px 0;text-align:left;font-weight:${label === "Total" ? "700" : "400"};">${escapeHtml(label)}</th><td style="padding:4px 0;text-align:right;font-weight:${label === "Total" ? "700" : "400"};">${escapeHtml(value)}</td></tr>`).join("")}</table>` : ""}
${order && !hasCurrency ? '<p style="color:#5f6368;">Order amounts are unavailable in this email.</p>' : ""}
${payment ? `<p style="margin:16px 0 24px;"><strong>Payment:</strong> ${escapeHtml(payment)}</p>` : ""}
${origin ? `<p style="margin:24px 0 12px;"><a href="${escapeHtml(`${origin}/account`)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;">View your account</a></p><p style="margin:0 0 24px;"><a href="${escapeHtml(`${origin}/`)}" style="color:#174ea6;">Visit store</a></p>` : ""}
${support.length ? `<div style="border-top:1px solid #dadce0;padding-top:16px;"><p style="margin:0 0 8px;">Need help?</p>${support.map((contact) => `<p style="margin:4px 0;"><a href="${escapeHtml(contact.href)}" style="color:#174ea6;">${escapeHtml(contact.label)}</a></p>`).join("")}</div>` : ""}
</div></body></html>`;
  return { subject, html, text };
}
