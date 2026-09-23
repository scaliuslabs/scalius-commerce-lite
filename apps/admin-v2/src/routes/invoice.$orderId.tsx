/* eslint-disable shadcn/no-inline-styles, shadcn/no-unknown-classes -- the invoice is a
   white paper document (screen and print) that must not follow the dashboard theme, so it
   carries its own print stylesheet and class names. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { getApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { InvoiceActions } from "~/components/admin/InvoiceActions";
import { formatDateTime, formatNumber, translate, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, paymentMethodLabel, paymentStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { apiData, type ApiResult } from "~/lib/api";
import { getAdminRouteContext } from "~/lib/admin-route-context";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { formatLocationParts } from "~/lib/location-presentation";
import { unixToDate } from "@scalius/shared/timestamps";
import { mediaImageUrl } from "@scalius/shared/media-variants";

type InvoiceDocument = ApiResult<typeof getApiV1AdminOrdersByIdInvoice>;

export const Route = createFileRoute("/invoice/$orderId")({
  // Same sign-in gates as the admin shell; the invoice API enforces RBAC.
  beforeLoad: async () => {
    await getAdminRouteContext();
  },
  loader: ({ params }): Promise<InvoiceDocument> =>
    apiData(getApiV1AdminOrdersByIdInvoice({ path: { id: params.orderId } })),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: loaderData?.status === "issued"
          ? `${translate(orderDetailMessages, "invoice.title")} ${loaderData.invoiceNumber}`
          : translate(orderDetailMessages, "invoice.draft"),
      },
    ],
  }),
  errorComponent: InvoiceError,
  component: InvoicePage,
});

function InvoicePage() {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const [document, setDocument] = useState<InvoiceDocument>(Route.useLoaderData());
  const { order, businessInfo } = document;
  const isIssued = document.status === "issued";

  if (!order) return <p className="p-6 text-body">{t("invoice.notFound")}</p>;

  const saved = resolveSavedOrderMoneySummary(order);
  const money = (major: number) => formatNumber(major, { maximumFractionDigits: 2 });
  const minor = (amount: number) => formatSavedMinorAmount(amount, saved!);
  const delivery = resolveDeliveryMethodPresentation(order, saved);
  const discount = order.discountAmount ?? 0;
  const issuedAt = unixToDate(document.issuedAt ?? order.createdAt);
  const businessName = businessInfo.companyName || businessInfo.legalName;
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
  const totals: Array<[string, string, string?]> = saved
    ? [
        [t("summary.subtotal"), minor(saved.subtotalMinor)],
        [delivery.label, minor(saved.shippingMinor), delivery.details],
        [t("summary.discount"), `${saved.discountMinor > 0 ? "−" : ""}${minor(saved.discountMinor)}`],
        [saved.pricesIncludeTax ? t("summary.taxIncluded", { label: saved.taxLabel }) : saved.taxLabel, minor(saved.taxMinor)],
      ]
    : [
        [t("summary.subtotal"), money(order.totalAmount - order.shippingCharge + discount)],
        [delivery.label, money(order.shippingCharge), delivery.details],
        ...(discount > 0 ? [[t("summary.discount"), `−${money(discount)}`] as [string, string]] : []),
      ];

  return (
    <div className="invoice-page">
      <style dangerouslySetInnerHTML={{ __html: INVOICE_CSS }} />
      <InvoiceActions
        orderId={order.id}
        issued={isIssued}
        expectedOrderVersion={document.orderVersion}
        onIssued={setDocument}
      />
      <article className="invoice">
        <header className="invoice-header">
          <div>
            <h1>{businessName || t("invoice.businessMissing")}</h1>
            {businessLines.map((line) => <p key={line}>{line}</p>)}
          </div>
          {businessInfo.invoiceLogoUrl ? (
            <img src={mediaImageUrl(businessInfo.invoiceLogoUrl, 480)} alt={businessName || ""} />
          ) : null}
        </header>

        <section className="invoice-meta">
          <div>
            <h2>{isIssued ? t("invoice.title") : t("invoice.draft")}</h2>
            <p className="strong">{document.invoiceNumber ?? t("invoice.notIssued")}</p>
            {issuedAt ? <p>{formatDateTime(issuedAt, { dateStyle: "medium" })}</p> : null}
            <p>{o("order", { id: order.id })}</p>
            <p>
              {paymentMethodLabel(o, order.paymentMethod ?? "cod")}
              {order.paymentStatus ? ` · ${paymentStatusLabel(o, order.paymentStatus)}` : ""}
            </p>
          </div>
          <div>
            <h2>{t("invoice.billTo")}</h2>
            <p className="strong">{order.customerName}</p>
            <p>{order.customerPhone}</p>
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
                    {line && line.discountMinor > 0 ? <small>{t("items.lineDiscount", { amount: minor(line.discountMinor) })}</small> : null}
                    {line && line.taxMinor > 0 ? <small>{saved!.taxLabel}: {minor(line.taxMinor)}</small> : null}
                  </td>
                  <td>{formatNumber(item.quantity)}</td>
                  <td>{line ? minor(line.unitPriceMinor) : money(item.price)}</td>
                  <td>{line ? minor(line.totalMinor) : money(item.price * item.quantity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <dl className="invoice-totals">
          {totals.map(([label, value, detail]) => (
            <div key={label}>
              <dt>{label}{detail ? <small>{detail}</small> : null}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div className="grand">
            <dt>{t("summary.total")}</dt>
            <dd>{saved ? minor(saved.totalMinor) : money(order.totalAmount)}</dd>
          </div>
        </dl>

        <footer>
          {businessInfo.invoiceFooterText ? <p>{businessInfo.invoiceFooterText}</p> : null}
          <p>{t("invoice.noSignature")}</p>
        </footer>
      </article>
    </div>
  );
}

function InvoiceError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-heading-lg font-semibold">{t("invoice.loadFailed")}</h1>
      {error.message ? <p className="text-body text-muted-foreground">{error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={reset}>{r("retry")}</Button>
        <Button variant="outline" asChild>
          <Link to="/admin/orders">{t("backToOrders")}</Link>
        </Button>
      </div>
    </main>
  );
}

/* Print document styles: a white A4 sheet on screen and on paper. */
const INVOICE_CSS = `
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
.invoice th:not(:first-child), .invoice td:not(:first-child) { text-align: right; white-space: nowrap; }
.invoice-totals { margin: 16px 0 32px auto; max-width: 300px; }
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
  .invoice { margin: 0; padding: 0; max-width: none; }
}
`;
