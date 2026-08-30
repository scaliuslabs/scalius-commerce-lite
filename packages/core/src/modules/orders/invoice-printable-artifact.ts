import type { InvoiceDocument, InvoiceOrderItemSnapshot } from "./invoice-snapshot";
import { ServiceUnavailableError } from "../../errors";

export const MAX_PRINTABLE_INVOICE_BYTES = 65_536;

function html(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(
  amount: number,
  currencyCode: string | null,
  decimalPlaces: number | null,
  minor = false,
): string {
  const code = currencyCode?.trim().toUpperCase() || "BDT";
  const decimals = decimalPlaces == null ? 2 : Math.min(3, Math.max(0, decimalPlaces));
  const major = minor ? amount / (10 ** decimals) : amount;
  return `${html(code)} ${major.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function itemTotal(item: InvoiceOrderItemSnapshot, decimalPlaces: number): number {
  return item.lineSubtotalMinor ?? Math.round(item.price * item.quantity * (10 ** decimalPlaces));
}

export function renderPrintableInvoice(document: InvoiceDocument): string {
  const { order, businessInfo } = document;
  const decimals = order.currencyDecimalPlaces ?? 2;
  const address = [order.shippingAddress, order.areaName ?? order.area, order.zoneName ?? order.zone, order.cityName ?? order.city]
    .filter(Boolean)
    .map(html)
    .join(", ");
  const issuedAt = document.issuedAt ?? order.createdAt;
  const date = new Date(typeof issuedAt === "number" && issuedAt < 1_000_000_000_000 ? issuedAt * 1000 : issuedAt)
    .toISOString()
    .slice(0, 10);
  const rows = order.items.map((item) => `
    <tr><td>${html(item.productName || item.productId)}${item.variantLabel ? `<small>${html(item.variantLabel)}</small>` : ""}</td>
    <td>${item.quantity}</td><td>${formatMoney(item.unitPriceMinor ?? Math.round(item.price * (10 ** decimals)), order.currencyCode, decimals, true)}</td>
    <td>${formatMoney(itemTotal(item, decimals), order.currencyCode, decimals, true)}</td></tr>`).join("");
  const subtotalMinor = order.subtotalAmountMinor ?? Math.round((order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0)) * (10 ** decimals));
  const shippingMinor = order.shippingAmountMinor ?? Math.round(order.shippingCharge * (10 ** decimals));
  const shippingLabel = order.shippingMethodName
    ? `Delivery — ${order.shippingMethodName}`
    : "Shipping";
  const shippingDetails = [
    order.shippingMethodDescription,
    order.shippingFeeWaived === true && order.shippingMethodBaseAmountMinor !== null
      ? `${formatMoney(order.shippingMethodBaseAmountMinor, order.currencyCode, decimals, true)} fee waived`
      : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const discountMinor = order.discountAmountMinor ?? Math.round((order.discountAmount ?? 0) * (10 ** decimals));
  const totalMinor = order.totalAmountMinor ?? Math.round(order.totalAmount * (10 ** decimals));

  const output = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(document.status === "issued" ? `Invoice ${document.invoiceNumber}` : `Draft invoice ${order.id}`)}</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#1f2937;font:14px system-ui,sans-serif}main{max-width:182mm;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #111827;padding-bottom:18px;margin-bottom:24px}h1{margin:0;color:#111827;font-size:24px}p{margin:4px 0}.muted,small{color:#6b7280}small{display:block}.meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left}th{font-size:11px;text-transform:uppercase}td:nth-child(n+2),th:nth-child(n+2){text-align:right}.totals{margin:24px 0 32px auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:5px}.total{border-top:2px solid #111827;margin-top:6px;padding-top:10px!important;font-weight:700}footer{text-align:center;border-top:1px solid #e5e7eb;padding-top:14px;color:#6b7280}.draft{background:#fffbeb;border:1px solid #fde68a;padding:10px;margin-bottom:18px}@media print{.draft{break-inside:avoid}}
</style></head><body><main>${document.status === "draft" ? '<div class="draft"><strong>Draft invoice</strong> — no invoice number has been allocated.</div>' : ""}
<header><div><h1>${html(businessInfo.companyName || businessInfo.legalName || "Business identity not configured")}</h1><p>${html(businessInfo.addressLine1)}</p><p>${html(businessInfo.phone)} ${html(businessInfo.email)}</p></div>
<div><strong>${html(document.invoiceNumber ?? "Draft")}</strong><p>${date}</p><p>Order ${html(order.id)}</p></div></header>
<section class="meta"><div><strong>Bill to</strong><p>${html(order.customerName)}</p><p>${html(order.customerPhone)}</p><p>${html(order.customerEmail)}</p></div><div><strong>Ship to</strong><p>${address}</p><p>Payment: ${html(order.paymentMethod?.toUpperCase())} (${html(order.paymentStatus)})</p></div></section>
<table><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
<section class="totals"><div><span>Subtotal</span><span>${formatMoney(subtotalMinor, order.currencyCode, decimals, true)}</span></div><div><span>${html(shippingLabel)}${shippingDetails ? `<small>${html(shippingDetails)}</small>` : ""}</span><span>${formatMoney(shippingMinor, order.currencyCode, decimals, true)}</span></div>${discountMinor > 0 ? `<div><span>Discount</span><span>-${formatMoney(discountMinor, order.currencyCode, decimals, true)}</span></div>` : ""}<div><span>${html(order.taxLabel || "Tax")}</span><span>${formatMoney(order.taxAmountMinor, order.currencyCode, decimals, true)}</span></div><div class="total"><span>Total</span><span>${formatMoney(totalMinor, order.currencyCode, decimals, true)}</span></div></section>
<footer><p>${html(businessInfo.invoiceFooterText)}</p><p>This is a computer-generated invoice and does not require a signature.</p></footer></main></body></html>`;

  if (new TextEncoder().encode(output).byteLength > MAX_PRINTABLE_INVOICE_BYTES) {
    throw new ServiceUnavailableError("Printable invoice exceeds the safe artifact size limit.");
  }
  return output;
}
