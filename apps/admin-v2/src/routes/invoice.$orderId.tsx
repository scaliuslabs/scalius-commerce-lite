import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import type {
  GetApiV1AdminOrdersByIdInvoiceResponse,
  PostApiV1AdminOrdersByIdInvoiceData,
  PostApiV1AdminOrdersByIdInvoiceResponse,
} from "@scalius/api-client/types";
import { InvoiceActions } from "~/components/admin/InvoiceActions";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";

type ApiData<T> = T extends { success: true; data: infer Data } ? Data : never;
type InvoiceData = ApiData<GetApiV1AdminOrdersByIdInvoiceResponse>;
type OrderItem = InvoiceData["order"]["items"][number];
type IssueInvoiceBody = NonNullable<PostApiV1AdminOrdersByIdInvoiceData["body"]>;

const getOrderInvoiceData = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { apiGet } = await import("~/lib/api.server");
    return apiGet<InvoiceData>(`/orders/${data.id}/invoice`);
  });

const issueOrderInvoice = createServerFn({ method: "POST" })
  .validator((data: { id: string } & IssueInvoiceBody) => data)
  .handler(async ({ data }) => {
    const { apiPost } = await import("~/lib/api.server");
    const { id, ...body } = data;
    return apiPost<ApiData<PostApiV1AdminOrdersByIdInvoiceResponse>>(
      `/orders/${id}/invoice`,
      body,
    );
  });

/**
 * Verify that the user has a valid admin session.
 * Reuses the same auth check as admin routes but without loading RBAC.
 */
const requireAuth = createServerFn().handler(async () => {
  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  initBindings();

  const cookieHeader = getRequestHeader("cookie") ?? "";
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const authResult = await getAuthSession(headers);
  if (!authResult?.session || !authResult?.user) {
    throw redirect({ to: "/auth/login" });
  }
  if (authResult.user.twoFactorEnabled && !authResult.session.twoFactorVerified) {
    throw redirect({ to: "/auth/two-factor" });
  }
  return null;
});

export const Route = createFileRoute("/invoice/$orderId")({
  beforeLoad: () => requireAuth(),
  loader: async ({ params }) => {
    return getOrderInvoiceData({ data: { id: params.orderId } });
  },
  head: ({ loaderData }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: `${loaderData?.status === "issued" ? `Invoice ${loaderData.invoiceNumber}` : "Draft invoice"} | Scalius` },
    ],
  }),
  errorComponent: InvoiceError,
  component: InvoicePage,
});

function InvoicePage() {
  const initialDocument = Route.useLoaderData();
  const [document, setDocument] = useState(initialDocument);
  const { order, businessInfo } = document;
  const invoiceNumber = document.invoiceNumber ?? "Draft";
  const isIssued = document.status === "issued";

  if (!order) {
    return <div>Invoice not found</div>;
  }

  const discount = order.discountAmount ?? 0;
  const subtotal = order.totalAmount - order.shippingCharge + discount;
  const grandTotal = order.totalAmount;
  const savedSummary = resolveSavedOrderMoneySummary(order);

  const invoiceDate = toInvoiceDate(document.issuedAt ?? order.createdAt);
  const formattedDate = invoiceDate.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });

  const addressParts = [
    order.shippingAddress,
    order.areaName,
    order.zoneName,
    order.cityName,
  ].filter(Boolean);
  const customerAddress = addressParts.join(", ");

  return (
    <div style={{ background: "#f9fafb", minHeight: "100vh" }}>
      <style dangerouslySetInnerHTML={{ __html: invoiceStyles }} />
      {isIssued ? (
        <InvoiceActions invoiceNumber={invoiceNumber} />
      ) : (
        <InvoiceDraftActions
          orderId={order.id}
          expectedOrderVersion={document.orderVersion}
          onIssued={setDocument}
        />
      )}

      <div className="invoice-wrapper">
        <div id="invoice-document" className="invoice-document">
          {/* Business Header */}
          <div className="invoice-header">
            <div className="business-info">
              <h1>{businessInfo.companyName || businessInfo.legalName || "Business identity not configured"}</h1>
              {businessInfo.companyName && businessInfo.legalName && <div className="legal-name">{businessInfo.legalName}</div>}
              <div className="details">
                {businessInfo.addressLine1 && <div>{businessInfo.addressLine1}</div>}
                {businessInfo.addressLine2 && <div>{businessInfo.addressLine2}</div>}
                {(businessInfo.city || businessInfo.stateRegion || businessInfo.postalCode) && (
                  <div>{[businessInfo.city, businessInfo.stateRegion, businessInfo.postalCode].filter(Boolean).join(", ")}</div>
                )}
                {businessInfo.country && <div>{businessInfo.country}</div>}
                {businessInfo.phone && <div>Phone: {businessInfo.phone}</div>}
                {businessInfo.email && <div>Email: {businessInfo.email}</div>}
                {businessInfo.taxId && <div>TIN/BIN: {businessInfo.taxId}</div>}
              </div>
            </div>
            {businessInfo.invoiceLogoUrl && (
              <div className="business-logo">
                <img
                  src={getOptimizedImageUrl(
                    businessInfo.invoiceLogoUrl,
                    ADMIN_IMAGE_PRESETS.invoiceLogo,
                  )}
                  alt={businessInfo.companyName || businessInfo.legalName || "Business logo"}
                />
              </div>
            )}
          </div>

          {/* Invoice Metadata */}
          <div className="invoice-meta">
            <div className="meta-block">
              <h3>Invoice</h3>
              <p><span className="value">{invoiceNumber}</span></p>
              {!isIssued && <p className="draft-label">Not issued · no number allocated</p>}
              <p>Date: {formattedDate}</p>
              <p>Order: #{order.id}</p>
              <p>Payment: {order.paymentMethod?.toUpperCase()} ({order.paymentStatus})</p>
            </div>
            <div className="meta-block">
              <h3>Bill To</h3>
              <p className="value">{order.customerName}</p>
              <p>{order.customerPhone}</p>
              {order.customerEmail && <p>{order.customerEmail}</p>}
              <p>{customerAddress}</p>
            </div>
          </div>

          {/* Line Items */}
          <table className="items-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>Qty</th>
                <th>Unit Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(order.items || []).map((item: OrderItem, index: number) => {
                const variant = item.variantLabel;
                const savedLine = resolveSavedOrderLineMoney(item, savedSummary);
                const unitPrice = savedLine && savedSummary
                  ? formatSavedMinorAmount(savedLine.unitPriceMinor, savedSummary)
                  : item.price.toLocaleString();
                const lineTotal = savedLine && savedSummary
                  ? formatSavedMinorAmount(savedLine.totalMinor, savedSummary)
                  : (item.price * item.quantity).toLocaleString();
                return (
                  <tr key={item.id || `item-${index}`}>
                    <td>{index + 1}</td>
                    <td>
                      {item.productName || "Unknown Product"}
                      {variant && <div className="variant">{variant}</div>}
                      {savedLine && savedSummary && savedLine.discountMinor > 0 && (
                        <div className="line-money-note">Item discount: −{formatSavedMinorAmount(savedLine.discountMinor, savedSummary)}</div>
                      )}
                      {savedLine && savedSummary && savedLine.taxMinor > 0 && (
                        <div className="line-money-note">
                          {savedSummary.taxLabel}{savedSummary.pricesIncludeTax ? " included" : " added"}: {formatSavedMinorAmount(savedLine.taxMinor, savedSummary)}
                        </div>
                      )}
                    </td>
                    <td>{item.quantity}</td>
                    <td>{unitPrice}</td>
                    <td>{lineTotal}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Totals */}
          <div className="invoice-totals">
            <div className="totals-table">
              {savedSummary ? (
                <>
                  <div className="row"><span>Subtotal</span><span>{formatSavedMinorAmount(savedSummary.subtotalMinor, savedSummary)}</span></div>
                  <div className="row"><span>Shipping</span><span>{formatSavedMinorAmount(savedSummary.shippingMinor, savedSummary)}</span></div>
                  <div className="row discount"><span>Discount</span><span>{savedSummary.discountMinor > 0 ? "−" : ""}{formatSavedMinorAmount(savedSummary.discountMinor, savedSummary)}</span></div>
                  <div className="row"><span>{savedSummary.taxLabel}{savedSummary.pricesIncludeTax ? " (included)" : ""}</span><span>{formatSavedMinorAmount(savedSummary.taxMinor, savedSummary)}</span></div>
                  <div className="row grand-total"><span>Grand Total</span><span>{formatSavedMinorAmount(savedSummary.totalMinor, savedSummary)}</span></div>
                  <p className="saved-money-note">
                    Amounts saved in {savedSummary.currencyCode} when this order was placed.
                    {savedSummary.pricesIncludeTax && ` ${savedSummary.taxLabel} is already included in the prices above.`}
                  </p>
                </>
              ) : (
                <>
                  <div className="row"><span>Subtotal</span><span>{subtotal.toLocaleString()}</span></div>
                  <div className="row"><span>Shipping</span><span>{order.shippingCharge.toLocaleString()}</span></div>
                  {discount > 0 && (
                    <div className="row discount"><span>Discount</span><span>-{discount.toLocaleString()}</span></div>
                  )}
                  <div className="row grand-total"><span>Grand Total</span><span>{grandTotal.toLocaleString()}</span></div>
                </>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="invoice-footer">
            {businessInfo.invoiceFooterText && <p>{businessInfo.invoiceFooterText}</p>}
            <p>This is a computer-generated invoice and does not require a signature.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

let invoiceOperationFallback = 0;

function createInvoiceOperationKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `invoice:${globalThis.crypto.randomUUID()}`;
  }
  invoiceOperationFallback += 1;
  return `invoice:${Date.now().toString(36)}:${invoiceOperationFallback.toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function toInvoiceDate(value: string | number): Date {
  if (typeof value === "number") {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  return new Date(value);
}

function InvoiceDraftActions({
  orderId,
  expectedOrderVersion,
  onIssued,
}: {
  orderId: string;
  expectedOrderVersion: number;
  onIssued: (document: InvoiceData) => void;
}) {
  const operationKey = useRef<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    if (issuing) return;
    operationKey.current ??= createInvoiceOperationKey();
    setIssuing(true);
    setError(null);
    try {
      const document = await issueOrderInvoice({
        data: {
          id: orderId,
          operationKey: operationKey.current,
          expectedOrderVersion,
        },
      });
      operationKey.current = null;
      onIssued(document);
    } catch (issueError) {
      setError(issueError instanceof Error ? issueError.message : "Invoice could not be issued.");
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="invoice-draft-bar print:hidden">
      <div className="invoice-draft-bar-inner">
        <div>
          <strong>Draft invoice</strong>
          <span>No number has been allocated. Issue it only when the order facts are final.</span>
          {error && <span className="invoice-issue-error" role="alert">{error}</span>}
        </div>
        <button type="button" onClick={issue} disabled={issuing}>
          {issuing ? "Issuing…" : "Issue invoice"}
        </button>
      </div>
    </div>
  );
}

function InvoiceError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="invoice-error-state">
      <h1>Invoice could not be loaded</h1>
      <p>{error.message || "The invoice service did not return a usable response."}</p>
      <div>
        <button type="button" onClick={reset}>Try again</button>
        <a href="/admin/orders">Back to orders</a>
      </div>
    </main>
  );
}

const invoiceStyles = `
/* Reset — isolate the invoice page from any inherited oklch/Tailwind variables */
.invoice-wrapper *, .invoice-wrapper *::before, .invoice-wrapper *::after { color: inherit; }
.invoice-wrapper { max-width: 210mm; margin: 60px auto 40px; padding: 0 16px; color: #374151; font-family: system-ui, -apple-system, sans-serif; }
.invoice-document { background: white; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 4px; }
.invoice-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #e5e7eb; }
.business-info h1 { font-size: 24px; font-weight: 700; color: #111827; }
.business-info .legal-name { font-size: 13px; color: #6b7280; margin-top: 2px; }
.business-info .details { font-size: 13px; color: #4b5563; margin-top: 8px; line-height: 1.6; }
.business-logo img { max-height: 60px; max-width: 180px; object-fit: contain; }
.invoice-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
.meta-block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; font-weight: 600; margin-bottom: 8px; }
.meta-block p { font-size: 14px; color: #374151; line-height: 1.5; }
.meta-block .value { font-weight: 600; }
.meta-block .draft-label { color: #b45309; font-size: 12px; font-weight: 600; }
.items-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
.items-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; font-weight: 600; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
.items-table th:last-child, .items-table td:last-child { text-align: right; }
.items-table th:nth-child(4), .items-table td:nth-child(4) { text-align: right; }
.items-table td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f3f4f6; vertical-align: top; color: #374151; }
.items-table .variant { font-size: 12px; color: #6b7280; }
.items-table .line-money-note { margin-top: 2px; font-size: 11px; color: #6b7280; }
.invoice-totals { display: flex; justify-content: flex-end; margin-bottom: 32px; }
.totals-table { width: 280px; }
.totals-table .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; color: #374151; }
.totals-table .row.discount { color: #059669; }
.totals-table .row.grand-total { border-top: 2px solid #1f2937; margin-top: 8px; padding-top: 12px; font-size: 16px; font-weight: 700; color: #111827; }
.saved-money-note { margin-top: 8px; font-size: 11px; line-height: 1.45; color: #6b7280; }
.invoice-footer { border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; font-size: 12px; color: #9ca3af; line-height: 1.6; }
.invoice-draft-bar { position: fixed; inset: 0 0 auto; z-index: 50; border-bottom: 1px solid #fde68a; background: #fffbeb; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
.invoice-draft-bar-inner { max-width: 210mm; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; color: #78350f; }
.invoice-draft-bar-inner > div { min-width: 0; display: grid; gap: 2px; font-size: 13px; }
.invoice-draft-bar-inner strong { font-size: 14px; }
.invoice-draft-bar-inner button, .invoice-error-state button, .invoice-error-state a { border: 1px solid #92400e; border-radius: 6px; padding: 7px 12px; background: #92400e; color: white; font: 500 14px system-ui, sans-serif; cursor: pointer; text-decoration: none; white-space: nowrap; }
.invoice-draft-bar-inner button:disabled { cursor: wait; opacity: .6; }
.invoice-issue-error { color: #b91c1c; }
.invoice-error-state { max-width: 560px; margin: 15vh auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px; background: white; color: #111827; font-family: system-ui, sans-serif; }
.invoice-error-state h1 { margin: 0; font-size: 20px; }
.invoice-error-state p { margin: 8px 0 20px; color: #6b7280; }
.invoice-error-state > div { display: flex; flex-wrap: wrap; gap: 8px; }
.invoice-error-state a { border-color: #d1d5db; background: white; color: #374151; }
@media (max-width: 640px) { .invoice-draft-bar-inner { align-items: flex-start; flex-direction: column; } .invoice-draft-bar-inner button { width: 100%; } .invoice-wrapper { margin-top: 118px; } }
@media print { .print-hidden, .print\\:hidden { display: none !important; } body { background: white !important; } .invoice-wrapper { margin: 0; padding: 0; max-width: 100%; } .invoice-document { box-shadow: none; border-radius: 0; padding: 10mm 12mm; } @page { size: A4; margin: 10mm 12mm; } }
`;
