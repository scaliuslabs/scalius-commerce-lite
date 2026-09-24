import type { Database } from "@scalius/database/client";
import { orders, orderItems } from "@scalius/database/schema";
import { formatMoney, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { escapeHtml } from "@scalius/shared/html-escape";
import { fromMinor } from "@scalius/shared/money";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatBdMobile } from "@scalius/shared/phone-input";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { asc, eq } from "drizzle-orm";
import { MESSAGE_COPY, requestCopy } from "./message-copy";
import type { OrderNotificationType } from "./notification-types";
import { readStoreIdentity, storeHeaderHtml } from "./store-messages";

interface OrderEmailInput {
  orderId: string;
  type: OrderNotificationType;
  data?: Record<string, unknown>;
  storefrontUrl?: string;
}

// Read only persisted purchase facts, never today's catalog or an invoice issuance.
async function readOrderEmailContext(db: Database, orderId: string) {
  const [rows, store] = await Promise.all([
    db.select({ order: {
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      shippingAddress: orders.shippingAddress,
      areaName: orders.areaName,
      zoneName: orders.zoneName,
      cityName: orders.cityName,
      shippingMethodName: orders.shippingMethodName,
      shippingMethodDescription: orders.shippingMethodDescription,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
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
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
    readStoreIdentity(db),
  ]);
  const order = rows[0]?.order;
  if (!order) throw new Error("Order email details are unavailable");
  const items = rows.flatMap((row) => row.item ? [row.item] : []);
  return { order: { ...order, orderNumber: null as number | null }, items, store };
}

const CLOSED_STATUSES = new Set(["cancelled", "returned", "refunded", "partially_refunded"]);
const SECTION = "margin:24px 0 8px;font-size:18px;line-height:1.3;";
const MUTED = "color:#5f6368;";
const LINK = "color:#174ea6;";
const RULE = "border-bottom:1px solid #dadce0;";

/** Called only after the email target is eligible (and its receipt is claimed). */
export async function composeOrderEmail(input: OrderEmailInput, db: Database) {
  const { order, items, store } = await readOrderEmailContext(db, input.orderId);
  const copy = MESSAGE_COPY[store.language];
  const facts = {
    order: formatOrderNumber(order.orderNumber, input.orderId),
    trackingId: String(input.data?.trackingId ?? "").trim(),
    ...requestCopy(copy, input.data?.supportRequestType, input.data?.supportRequestStatus),
  };
  const subject = copy.subject[input.type](facts).replace(/[\r\n]+/g, " ");
  const message = copy.message[input.type](facts);
  const greeting = copy.greeting(order.customerName.trim());

  const currency = normalizeSupportedCurrencyCode(order.currencyCode);
  const decimals = order.currencyDecimalPlaces;
  const hasCurrency = currency !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 3;
  const money = (minor: number) => formatMoney(fromMinor(minor, decimals), { code: currency! });
  const summary: Array<[string, string]> = [];
  if (hasCurrency) {
    summary.push([copy.subtotal, money(order.subtotalAmountMinor)], [copy.shipping, money(order.shippingAmountMinor)]);
    if (order.discountAmountMinor > 0) summary.push([copy.discount, `−${money(order.discountAmountMinor)}`]);
    if (order.taxAmountMinor > 0) {
      summary.push([`${order.taxLabel || copy.tax}${order.pricesIncludeTax ? ` (${copy.taxIncluded})` : ""}`, money(order.taxAmountMinor)]);
    }
    summary.push([copy.total, money(order.totalAmountMinor)]);
  }

  let payment: string;
  if (order.paymentStatus === "refunded" || order.status === "refunded") payment = copy.refunded;
  else if (order.paymentStatus === "partially_refunded" || order.status === "partially_refunded") payment = copy.partiallyRefunded;
  else if (CLOSED_STATUSES.has(order.status)) payment = copy.nothingDue;
  else if (order.paymentStatus === "paid") payment = copy.paid;
  else if (order.paymentMethod === "cod") {
    payment = copy.cod(hasCurrency ? money(Math.max(0, order.balanceDueMinor)) : null, order.paymentStatus === "partial");
  } else payment = order.paymentStatus === "partial" ? copy.partiallyPaid : copy.paymentNotCompleted;

  const lines = items.map((item) => ({
    name: item.productName?.trim() || copy.itemUnavailable,
    variant: item.variantLabel?.trim(),
    quantity: hasCurrency ? `${item.quantity} × ${money(item.unitPriceMinor)}` : copy.quantity(item.quantity),
    subtotal: hasCurrency ? money(item.lineSubtotalMinor) : "",
  }));
  const address = [
    order.customerName,
    order.customerPhone ? formatBdMobile(order.customerPhone) : null,
    order.shippingAddress,
    [order.areaName, order.zoneName, order.cityName].map((part) => part?.trim()).filter(Boolean).join(", "),
  ].map((line) => line?.trim()).filter((line): line is string => Boolean(line));
  const method = [order.shippingMethodName, order.shippingMethodDescription]
    .map((line) => line?.trim()).filter((line): line is string => Boolean(line));

  // Account orders open in the account; guests verify on the public order page.
  // Phone and email never go into these URLs.
  const origin = normalizeStorefrontOrigin(input.storefrontUrl);
  const cta = origin ? order.accountOwnerCustomerId
    ? { label: copy.viewOrder, href: `${origin}/account/orders/${encodeURIComponent(input.orderId)}` }
    : { label: copy.trackOrder, href: `${origin}/track-order?order=${encodeURIComponent(String(order.orderNumber ?? input.orderId))}` }
    : null;
  const support: Array<{ label: string; href: string }> = [];
  const email = store.business.email.trim();
  const phone = store.business.phone.trim();
  if (email && /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(email)) {
    support.push({ label: email, href: `mailto:${encodeURIComponent(email)}` });
  }
  if (phone && /^\+?[\d][\d ()-]{5,24}$/.test(phone)) {
    support.push({ label: phone, href: `tel:${phone.replace(/[ ()-]/g, "")}` });
  }

  const text = [
    store.name, subject, greeting, message,
    cta ? `${cta.label}: ${cta.href}` : "",
    lines.length || summary.length ? copy.orderSummary : "",
    ...lines.map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}\n${item.quantity}${item.subtotal ? ` — ${item.subtotal}` : ""}`),
    summary.map(([label, value]) => `${label}: ${value}`).join("\n"),
    hasCurrency ? "" : copy.amountsUnavailable,
    `${copy.payment}: ${payment}`,
    address.length ? `${copy.deliveryAddress}\n${address.join("\n")}` : "",
    method.length ? `${copy.deliveryMethod}\n${method.join("\n")}` : "",
    origin ? `${copy.visitStore}: ${origin}/` : "",
    support.length ? `${copy.needHelp}\n${support.map((contact) => contact.label).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const html = `<!doctype html><html lang="${store.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(store)}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${escapeHtml(subject)}</h1>
<p style="margin:0 0 8px;">${escapeHtml(greeting)}</p><p style="margin:0 0 24px;">${escapeHtml(message)}</p>
${cta ? `<p style="margin:0 0 12px;"><a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(cta.label)}</a></p><p style="margin:0 0 24px;"><a href="${escapeHtml(`${origin}/`)}" style="${LINK}">${escapeHtml(copy.visitStore)}</a></p>` : ""}
<h2 style="${SECTION}">${escapeHtml(copy.orderSummary)}</h2>
${lines.length ? `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr><th scope="col" style="text-align:left;padding:0 8px 8px 0;${RULE}">${escapeHtml(copy.items)}</th><th scope="col" style="width:34%;text-align:right;padding:0 0 8px;${RULE}">${hasCurrency ? escapeHtml(copy.subtotal) : ""}</th></tr></thead><tbody>${lines.map((item) => `<tr><td style="padding:12px 8px 12px 0;vertical-align:top;${RULE}"><strong>${escapeHtml(item.name)}</strong>${item.variant ? `<div style="${MUTED}">${escapeHtml(item.variant)}</div>` : ""}<div style="font-size:14px;${MUTED}">${escapeHtml(item.quantity)}</div></td><td style="padding:12px 0;vertical-align:top;text-align:right;${RULE}">${escapeHtml(item.subtotal)}</td></tr>`).join("")}</tbody></table>` : ""}
${summary.length ? `<table aria-label="${escapeHtml(copy.orderSummary)}" style="width:100%;border-collapse:collapse;margin:16px 0;">${summary.map(([label, value], index) => {
    const weight = index === summary.length - 1 ? "700" : "400";
    return `<tr><th scope="row" style="padding:4px 12px 4px 0;text-align:left;font-weight:${weight};">${escapeHtml(label)}</th><td style="padding:4px 0;text-align:right;font-weight:${weight};">${escapeHtml(value)}</td></tr>`;
  }).join("")}</table>` : `<p style="${MUTED}">${escapeHtml(copy.amountsUnavailable)}</p>`}
<p style="margin:16px 0 0;"><strong>${escapeHtml(copy.payment)}:</strong> ${escapeHtml(payment)}</p>
${address.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryAddress)}</h2><p style="margin:0;">${address.map((line) => escapeHtml(line)).join("<br>")}</p>` : ""}
${method.length ? `<h2 style="${SECTION}">${escapeHtml(copy.deliveryMethod)}</h2><p style="margin:0;">${escapeHtml(method[0]!)}${method[1] ? `<br><span style="${MUTED}">${escapeHtml(method[1])}</span>` : ""}</p>` : ""}
${support.length ? `<div style="margin-top:24px;border-top:1px solid #dadce0;padding-top:16px;"><p style="margin:0 0 8px;">${escapeHtml(copy.needHelp)}</p>${support.map((contact) => `<p style="margin:4px 0;"><a href="${escapeHtml(contact.href)}" style="${LINK}">${escapeHtml(contact.label)}</a></p>`).join("")}</div>` : ""}
</div></body></html>`;
  return { subject, html, text, fromName: store.name ?? undefined };
}
