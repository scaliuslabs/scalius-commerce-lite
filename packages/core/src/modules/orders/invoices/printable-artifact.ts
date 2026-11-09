import { countryDisplayName } from "@scalius/shared/address";
import { formatOrderShippingAddress } from "../shipping-address";
import { formatOrderBillingAddress } from "../billing-display";
import type { InvoiceDocument, InvoiceOrderItemSnapshot } from "./snapshot";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { ServiceUnavailableError } from "../../../errors";
import { paymentMethodLabel } from "../../payments";
import { formatAmount, moneyLocale } from "@scalius/shared/money-format";
import { formatDateTime, formatNumber } from "@scalius/shared/locale-format";
import { lineEntryWords, presentLineEntry } from "@scalius/shared/line-entry-words";
import { presentCheckoutAttributes } from "@scalius/shared/plugins/checkout-attribute-text";
import { INVOICE_COPY, type InvoiceLanguage } from "./invoice-copy";
import { invoiceRefundSummary } from "@scalius/shared/invoice-refunds";
import { isFreeOrderLine } from "@scalius/shared/order-money-presentation";

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
  language: InvoiceLanguage = "en",
): string {
  const code = currencyCode?.trim().toUpperCase() || "BDT";
  const decimals = decimalPlaces == null ? 2 : Math.min(3, Math.max(0, decimalPlaces));
  const major = minor ? amount / (10 ** decimals) : amount;
  return `${html(code)} ${formatAmount(major, moneyLocale(code, language), decimals)}`;
}

function itemTotal(item: InvoiceOrderItemSnapshot, decimalPlaces: number): number {
  return item.lineSubtotalMinor ?? Math.round(item.price * item.quantity * (10 ** decimalPlaces));
}

/** A line its own discount pays in full (a free gift) prints ৳0 with its price struck. */
function isFreeLine(item: InvoiceOrderItemSnapshot): boolean {
  return isFreeOrderLine({
    grossSubtotalMinor: item.lineSubtotalMinor ?? 0,
    discountMinor: item.discountAmountMinor ?? 0,
  });
}

/** Long free-text inputs are cut on the printout so an invoice stays one bounded page. */
const PRINTED_PROPERTY_VALUE_LENGTH = 200;

function printedPropertyValue(value: string): string {
  const characters = [...value];
  return characters.length > PRINTED_PROPERTY_VALUE_LENGTH
    ? `${characters.slice(0, PRINTED_PROPERTY_VALUE_LENGTH - 1).join("")}…`
    : value;
}

/** "Engraving: Anika (+BDT 200.00)" under the line, escaped; the platform's words ("Yes", "Add-on") in the invoice's language. */
function itemProperties(
  item: InvoiceOrderItemSnapshot,
  currencyCode: string | null,
  decimalPlaces: number,
  language: InvoiceLanguage,
): string {
  const words = lineEntryWords(language);
  const count = (value: number) => formatNumber(value, language === "bn" ? "bn-BD" : "en-US");
  return (item.properties ?? []).map((frozen) => {
    const property = presentLineEntry({ ...frozen, key: frozen.key ?? "" }, words, count);
    const surcharge = property.priceMinor > 0
      ? ` (+${formatMoney(property.priceMinor, currencyCode, decimalPlaces, true, language)})`
      : "";
    return `<small>${html(property.label)}: ${html(printedPropertyValue(property.displayValue))}${surcharge}</small>`;
  }).join("");
}

export function renderPrintableInvoice(
  document: InvoiceDocument,
  /** The store's zone: the issue date is the store's calendar day. */
  timeZone: string,
  /**
   * The language it prints in: the order's for the buyer's copy (`readOrderMessageScope`),
   * the staff member's for a staff copy. Words, dates, numbers and money all follow it.
   */
  language: InvoiceLanguage = "en",
): string {
  const { order, businessInfo } = document;
  const decimals = order.currencyDecimalPlaces ?? 2;
  const copy = INVOICE_COPY[language];
  const money = (amount: number, minor = true) => formatMoney(amount, order.currencyCode, decimals, minor, language);
  const number = (value: number) => formatNumber(value, language === "bn" ? "bn-BD" : "en-US");
  // The store's calendar day, written in the invoice's language.
  const day = (value: Date) => formatDateTime(value, language === "bn" ? "bn-BD" : "en-GB", { timeZone, dateStyle: "medium" });
  // A Bangladesh address reads as it always has (line, area, thana, city);
  // another country's adds its region, postal code and country name.
  const address = html(formatOrderShippingAddress(order, { countryName: countryDisplayName }));
  // Pickup and service-only orders carry no address (Wave A).
  const shipToHeading = address ? copy.shipTo : order.shippingMethodName ? copy.pickup : copy.delivery;
  const shipToText = address || (order.shippingMethodName ? html(order.shippingMethodName) : copy.noDelivery);
  // The billing address (0119): the shipping address when it bills; none on older orders.
  const billingAddress = formatOrderBillingAddress(order, { countryName: countryDisplayName });
  const billToName = order.billingSameAsShipping ? order.customerName : order.billingName || order.customerName;
  const billTo = [
    `<p>${html(billToName)}</p>`,
    order.billingSameAsShipping || !order.billingCompany ? "" : `<p>${html(order.billingCompany)}</p>`,
    billingAddress ? `<p>${html(billingAddress)}</p>` : "",
    `<p>${html(order.customerPhone)}</p><p>${html(order.customerEmail)}</p>`,
    // A tax-exempt buyer (0178): no tax was charged; the number they gave, when any.
    order.taxExemption
      ? `<p><strong>${copy.taxExempt}</strong>${order.taxExemption.exemptionId ? ` · ${html(order.taxExemption.exemptionId)}` : ""}</p>`
      : "",
  ].join("");
  const issuedAt = document.issuedAt ?? order.createdAt;
  const date = day(new Date(typeof issuedAt === "number" && issuedAt < 1_000_000_000_000 ? issuedAt * 1000 : issuedAt));
  // Net terms print with their due day on the store calendar, as the issue date does.
  const terms = order.paymentTerms
    ? `<p><strong>${copy.terms(number(order.paymentTerms.days))}</strong> · ${copy.due(day(new Date(order.paymentTerms.dueAt)))}</p>`
    : "";
  // The apps' checkout answers (a delivery day and window), each under the
  // app's label in the invoice's language, with a choice's label and a date
  // in its format: the same presenter as the order page and the emails.
  const appAnswers = presentCheckoutAttributes(order.appAnswers ?? {}, order.attributeApps ?? [], {
    locale: language,
    defaultLocale: language,
    words: lineEntryWords(language),
  }).flatMap((group) => group.entries.map((entry) => `<p>${html(entry.label)}: ${html(entry.value)}</p>`)).join("");
  const free = (amount: string) => `<s>${amount}</s> ${money(0)}`;
  const rows = order.items.map((item) => {
    const unit = money(item.unitPriceMinor ?? Math.round(item.price * (10 ** decimals)));
    const total = money(itemTotal(item, decimals));
    return `
    <tr><td>${html(item.productName || item.productId)}${item.variantLabel ? `<small>${html(item.variantLabel)}</small>` : ""}${itemProperties(item, order.currencyCode, decimals, language)}</td>
    <td>${number(item.quantity)}${item.returnedQuantity ? `<small>${copy.returned(number(item.returnedQuantity))}</small>` : ""}</td><td>${isFreeLine(item) ? free(unit) : unit}</td>
    <td>${isFreeLine(item) ? free(total) : total}</td></tr>`;
  }).join("");
  const subtotalMinor = order.subtotalAmountMinor ?? Math.round((order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0)) * (10 ** decimals));
  const shippingMinor = order.shippingAmountMinor ?? Math.round(order.shippingCharge * (10 ** decimals));
  const shippingLabel = order.shippingMethodName
    ? copy.deliveryMethod(order.shippingMethodName)
    : copy.shipping;
  const shippingDetails = [
    order.shippingMethodDescription,
    order.shippingFeeWaived === true && order.shippingMethodBaseAmountMinor !== null
      ? copy.feeWaived(money(order.shippingMethodBaseAmountMinor))
      : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const discountMinor = order.discountAmountMinor ?? Math.round((order.discountAmount ?? 0) * (10 ** decimals));
  const { totalMinor, refundedMinor, refundedSinceIssueMinor, totalRefundedMinor, netTotalMinor } = invoiceRefundSummary(document);

  const payment = order.paymentMethod === "cod" ? copy.cashOnDelivery : order.paymentMethod ? paymentMethodLabel(order.paymentMethod) : null;
  const paymentStatus = order.paymentStatus ? copy.paymentStatus[order.paymentStatus] ?? order.paymentStatus : null;
  const orderNumber = formatOrderNumber(order.orderNumber, order.id);
  const output = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(document.status === "issued" ? copy.invoice(document.invoiceNumber ?? "") : copy.draftInvoice(orderNumber))}</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#1f2937;font:14px system-ui,sans-serif}main{max-width:182mm;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #111827;padding-bottom:18px;margin-bottom:24px}h1{margin:0;color:#111827;font-size:24px}p{margin:4px 0}.muted,small{color:#6b7280}small{display:block}.meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left}th{font-size:11px;text-transform:uppercase}td:nth-child(n+2),th:nth-child(n+2){text-align:right}.totals{margin:24px 0 32px auto;width:280px}.totals div{display:flex;justify-content:space-between;padding:5px}.total{border-top:2px solid #111827;margin-top:6px;padding-top:10px!important;font-weight:700}footer{text-align:center;border-top:1px solid #e5e7eb;padding-top:14px;color:#6b7280}.draft{background:#fffbeb;border:1px solid #fde68a;padding:10px;margin-bottom:18px}@media print{.draft{break-inside:avoid}}
</style></head><body><main>${document.status === "draft" ? `<div class="draft"><strong>${copy.draftBanner}</strong> — ${copy.draftBannerDetail}</div>` : ""}
<header><div><h1>${html(businessInfo.companyName || businessInfo.legalName)}</h1><p>${html(businessInfo.addressLine1)}</p><p>${html(businessInfo.phone)} ${html(businessInfo.email)}</p></div>
<div><strong>${html(document.invoiceNumber ?? copy.draft)}</strong><p>${date}</p><p>${html(copy.order(orderNumber))}</p></div></header>
<section class="meta"><div><strong>${copy.billTo}</strong>${billTo}</div><div><strong>${shipToHeading}</strong><p>${shipToText}</p><p>${copy.payment}: ${html(payment)}${paymentStatus ? ` (${html(paymentStatus)})` : ""}</p>${terms}${appAnswers}</div></section>
<table><thead><tr><th>${copy.item}</th><th>${copy.qty}</th><th>${copy.unitPrice}</th><th>${copy.amount}</th></tr></thead><tbody>${rows}</tbody></table>
<section class="totals"><div><span>${copy.subtotal}</span><span>${money(subtotalMinor)}</span></div><div><span>${html(shippingLabel)}${shippingDetails ? `<small>${html(shippingDetails)}</small>` : ""}</span><span>${money(shippingMinor)}</span></div>${discountMinor > 0 ? `<div><span>${copy.discount}</span><span>-${money(discountMinor)}</span></div>` : ""}<div><span>${html(order.taxLabel && order.taxLabel.trim().toLowerCase() !== "tax" ? order.taxLabel : copy.tax)}</span><span>${money(order.taxAmountMinor)}</span></div><div class="total"><span>${copy.total}</span><span>${money(totalMinor)}</span></div>${refundedMinor > 0 ? `<div><span>${copy.refunded}</span><span>-${money(refundedMinor)}</span></div>` : ""}${refundedSinceIssueMinor > 0 ? `<div><span>${copy.refundedSinceIssue}</span><span>-${money(refundedSinceIssueMinor)}</span></div>` : ""}${totalRefundedMinor > 0 ? `<div class="total"><span>${copy.totalAfterRefunds}</span><span>${money(netTotalMinor)}</span></div>` : ""}</section>
<footer><p>${html(businessInfo.invoiceFooterText)}</p><p>${copy.noSignature}</p></footer></main></body></html>`;

  if (new TextEncoder().encode(output).byteLength > MAX_PRINTABLE_INVOICE_BYTES) {
    throw new ServiceUnavailableError("Printable invoice exceeds the safe artifact size limit.");
  }
  return output;
}
