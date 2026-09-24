/* eslint-disable shadcn/no-unknown-classes -- the invoice is a white paper document (screen and
   print) that must not follow the dashboard theme, so it carries its own stylesheet and classes. */
import type { getApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatPhoneForProvider } from "@scalius/shared/customer-utils";
import { unixToDate } from "@scalius/shared/timestamps";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, paymentMethodLabel, paymentStatusLabel } from "~/i18n/orders";
import type { ApiResult } from "~/lib/api";
import {
  formatSavedMajorAmount,
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { formatLocationParts } from "~/lib/location-presentation";
import { taxLabelText } from "./OrderItemsCard";

export type InvoiceDocument = ApiResult<typeof getApiV1AdminOrdersByIdInvoice>;

/** The business name the invoice is issued under; empty until Settings → Store has one. */
export function invoiceBusinessName(document: Pick<InvoiceDocument, "businessInfo">): string {
  return document.businessInfo.companyName || document.businessInfo.legalName;
}

/** One printable invoice sheet (A4). Several stack with page breaks for bulk printing. */
export function InvoiceSheet({ document }: { document: InvoiceDocument }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const { order, businessInfo } = document;
  const saved = resolveSavedOrderMoneySummary(order);
  const money = (major: number) => (saved ? formatSavedMajorAmount(major, saved) : formatNumber(major, { maximumFractionDigits: 2 }));
  const minor = (amount: number) => formatSavedMinorAmount(amount, saved!);
  const delivery = resolveDeliveryMethodPresentation(order, saved);
  const discount = order.discountAmount ?? 0;
  const issuedAt = unixToDate(document.issuedAt ?? order.createdAt);
  const businessName = invoiceBusinessName(document);
  const refunded = Number(order.refundedAmount ?? 0);
  const businessLines = [
    businessInfo.companyName && businessInfo.legalName ? businessInfo.legalName : null,
    businessInfo.addressLine1,
    businessInfo.addressLine2,
    [businessInfo.city, businessInfo.stateRegion, businessInfo.postalCode].filter(Boolean).join(", "),
    businessInfo.country,
    businessInfo.phone,
    businessInfo.email,
    businessInfo.taxId ? `${t("invoice.taxId")}: ${businessInfo.taxId}` : null,
  ].filter(Boolean);
  const discounts: Array<[string, string]> = (order.discounts ?? []).length > 0
    ? (order.discounts ?? []).map((entry) => [
        entry.code ? t("summary.discountCode", { code: entry.code }) : entry.name,
        `−${money(entry.amount)}`,
      ])
    : (saved ? saved.discountMinor : discount) > 0
      ? [[t("summary.discount"), `−${saved ? minor(saved.discountMinor) : money(discount)}`]]
      : [];
  const totals: Array<[string, string, string?]> = [
    [t("summary.subtotal"), saved ? minor(saved.subtotalMinor) : money(order.totalAmount - order.shippingCharge + discount)],
    [delivery.label, saved ? minor(saved.shippingMinor) : money(order.shippingCharge), delivery.details],
    ...discounts,
    ...(saved && saved.taxMinor > 0
      ? [[
          saved.pricesIncludeTax ? t("summary.taxIncluded", { label: taxLabelText(saved.taxLabel, t) }) : taxLabelText(saved.taxLabel, t),
          minor(saved.taxMinor),
        ] as [string, string]]
      : []),
  ];

  return (
    <article className="invoice">
      <header className="invoice-header">
        <div>
          {businessName ? <h1>{businessName}</h1> : null}
          {businessLines.map((line) => <p key={line}>{line}</p>)}
        </div>
        {businessInfo.invoiceLogoUrl ? (
          <img src={mediaImageUrl(businessInfo.invoiceLogoUrl, 480)} alt={businessName} />
        ) : null}
      </header>

      <section className="invoice-meta">
        <div>
          <h2>{t("invoice.title")}</h2>
          {document.status === "issued" && document.invoiceNumber ? <p className="strong">{document.invoiceNumber}</p> : null}
          {issuedAt ? <p>{formatDateTime(issuedAt, { dateStyle: "medium" })}</p> : null}
          <p>{o("order", { number: formatOrderNumber(order.orderNumber, order.id) })}</p>
          <p>
            {paymentMethodLabel(o, order.paymentMethod ?? "cod")}
            {order.paymentStatus ? ` · ${paymentStatusLabel(o, order.paymentStatus)}` : ""}
          </p>
        </div>
        <div>
          <h2>{t("invoice.billTo")}</h2>
          <p className="strong">{order.customerName}</p>
          {/* Local format, as the customer writes it: 01712345678. */}
          <p>{formatPhoneForProvider(order.customerPhone)}</p>
          {order.customerEmail ? <p>{order.customerEmail}</p> : null}
          <p>{formatLocationParts(order.shippingAddress, order.areaName, order.zoneName, order.cityName)}</p>
        </div>
      </section>

      <table>
        <thead>
          <tr>
            <th>{t("invoice.item")}</th>
            <th>{t("invoice.qty")}</th>
            <th>{t("invoice.price")}</th>
            <th>{t("summary.total")}</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => {
            const line = resolveSavedOrderLineMoney(item, saved);
            return (
              <tr key={item.id}>
                <td>
                  {item.productName || t("items.unnamed")}
                  {item.variantLabel ? <small>{item.variantLabel}</small> : null}
                  {(item.returnedQuantity ?? 0) > 0 ? <small>{t("items.returned", { count: item.returnedQuantity ?? 0 })}</small> : null}
                </td>
                <td>{formatNumber(item.quantity)}</td>
                <td>{line ? minor(line.unitPriceMinor) : money(item.price)}</td>
                <td>{line ? minor(line.grossSubtotalMinor) : money(item.price * item.quantity)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <dl className="invoice-totals">
        {totals.map(([label, value, detail], index) => (
          <div key={`${label}:${index}`}>
            <dt>{label}{detail ? <small>{detail}</small> : null}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="grand">
          <dt>{t("summary.total")}</dt>
          <dd>{saved ? minor(saved.totalMinor) : money(order.totalAmount)}</dd>
        </div>
        {refunded > 0 ? (
          <>
            <div>
              <dt>{t("payment.refunded")}</dt>
              <dd>−{money(refunded)}</dd>
            </div>
            <div className="strong">
              <dt>{t("payment.net")}</dt>
              <dd>{money(Math.max(0, order.totalAmount - refunded))}</dd>
            </div>
          </>
        ) : null}
      </dl>

      <footer>
        {businessInfo.invoiceFooterText ? <p>{businessInfo.invoiceFooterText}</p> : null}
        <p>{t("invoice.noSignature")}</p>
      </footer>
    </article>
  );
}

/* Print document styles: white A4 sheets on screen and on paper. */
export const INVOICE_CSS = `
.invoice-page { min-height: 100vh; background: #f4f4f5; color: #18181b; }
.invoice { max-width: 210mm; margin: 24px auto; padding: 40px; background: #fff; font-size: 14px; line-height: 1.5; }
.invoice h1 { font-size: 22px; font-weight: 600; }
.invoice h2 { font-size: 13px; font-weight: 600; color: #71717a; margin-bottom: 4px; }
.invoice p, .invoice small { color: #52525b; }
.invoice .strong { color: #18181b; font-weight: 600; }
.invoice small { display: block; font-size: 12px; }
.invoice-header { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 20px; border-bottom: 2px solid #e4e4e7; }
.invoice-header img { max-height: 60px; max-width: 180px; object-fit: contain; }
.invoice-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
.invoice table { width: 100%; border-collapse: collapse; }
.invoice th { text-align: left; font-size: 12px; font-weight: 600; color: #71717a; padding: 8px; border-bottom: 2px solid #e4e4e7; }
.invoice td { padding: 10px 8px; border-bottom: 1px solid #f4f4f5; vertical-align: top; }
.invoice th:not(:first-child), .invoice td:not(:first-child) { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.invoice-totals { margin: 16px 0 32px auto; max-width: 300px; font-variant-numeric: tabular-nums; }
.invoice-totals div { display: flex; justify-content: space-between; gap: 16px; padding: 4px 0; }
.invoice-totals .grand { border-top: 2px solid #18181b; margin-top: 8px; padding-top: 10px; font-size: 16px; font-weight: 600; }
.invoice footer { border-top: 1px solid #e4e4e7; padding-top: 12px; text-align: center; font-size: 12px; }
@media (max-width: 640px) {
  .invoice { margin: 0; padding: 16px; }
  .invoice-header { flex-direction: column-reverse; }
  .invoice-meta { grid-template-columns: 1fr; gap: 16px; }
  .invoice th, .invoice td { padding: 8px 4px; }
}
@page { size: A4; margin: 12mm; }
@media print {
  .invoice-page { background: #fff; }
  .invoice { margin: 0; padding: 0; max-width: none; break-after: page; }
  .invoice:last-child { break-after: auto; }
}
`;
