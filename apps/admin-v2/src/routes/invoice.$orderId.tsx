import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { InvoiceActions } from "~/components/admin/InvoiceActions";
import type { InvoiceData, OrderItem } from "~/types/api-responses";

const getOrderInvoiceData = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  // @ts-expect-error -- Known TanStack Start handler type issue
  .handler(async ({ data }) => {
    const { apiGet } = await import("~/lib/api.server");
    return apiGet<InvoiceData>(`/orders/${data.id}/invoice`);
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
    const result = await getOrderInvoiceData({ data: { id: params.orderId } }).catch(() => null);
    if (!result) throw redirect({ to: "/admin/orders" });
    const r = result as InvoiceData;
    return {
      order: r.order,
      invoiceNumber: r.invoiceNumber || "",
      businessInfo: r.businessInfo || {},
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: `Invoice ${loaderData?.invoiceNumber || ""} | Scalius` },
    ],
  }),
  component: InvoicePage,
});

function InvoicePage() {
  const { order, invoiceNumber, businessInfo } = Route.useLoaderData();

  if (!order) {
    return <div>Invoice not found</div>;
  }

  const discount = order.discountAmount ?? 0;
  const subtotal = order.totalAmount - order.shippingCharge + discount;
  const grandTotal = order.totalAmount;

  const invoiceDate = order.createdAt instanceof Date
    ? order.createdAt
    : typeof order.createdAt === "number"
      ? new Date(order.createdAt)
      : new Date(order.createdAt);
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
      <InvoiceActions invoiceNumber={invoiceNumber} />

      <div className="invoice-wrapper">
        <div id="invoice-document" className="invoice-document">
          {/* Business Header */}
          <div className="invoice-header">
            <div className="business-info">
              <h1>{businessInfo.companyName || "Your Business"}</h1>
              {businessInfo.legalName && <div className="legal-name">{businessInfo.legalName}</div>}
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
                <img src={businessInfo.invoiceLogoUrl} alt={businessInfo.companyName || "Logo"} />
              </div>
            )}
          </div>

          {/* Invoice Metadata */}
          <div className="invoice-meta">
            <div className="meta-block">
              <h3>Invoice</h3>
              <p><span className="value">{invoiceNumber}</span></p>
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
                const variant = [item.variantSize, item.variantColor].filter(Boolean).join(" / ");
                const lineTotal = item.price * item.quantity;
                return (
                  <tr key={item.id || `item-${index}`}>
                    <td>{index + 1}</td>
                    <td>
                      {item.productName || "Unknown Product"}
                      {variant && <div className="variant">{variant}</div>}
                    </td>
                    <td>{item.quantity}</td>
                    <td>{item.price.toLocaleString()}</td>
                    <td>{lineTotal.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Totals */}
          <div className="invoice-totals">
            <div className="totals-table">
              <div className="row"><span>Subtotal</span><span>{subtotal.toLocaleString()}</span></div>
              <div className="row"><span>Shipping</span><span>{order.shippingCharge.toLocaleString()}</span></div>
              {discount > 0 && (
                <div className="row discount"><span>Discount</span><span>-{discount.toLocaleString()}</span></div>
              )}
              <div className="row grand-total"><span>Grand Total</span><span>{grandTotal.toLocaleString()}</span></div>
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
.items-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
.items-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; font-weight: 600; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
.items-table th:last-child, .items-table td:last-child { text-align: right; }
.items-table th:nth-child(4), .items-table td:nth-child(4) { text-align: right; }
.items-table td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f3f4f6; vertical-align: top; color: #374151; }
.items-table .variant { font-size: 12px; color: #6b7280; }
.invoice-totals { display: flex; justify-content: flex-end; margin-bottom: 32px; }
.totals-table { width: 280px; }
.totals-table .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; color: #374151; }
.totals-table .row.discount { color: #059669; }
.totals-table .row.grand-total { border-top: 2px solid #1f2937; margin-top: 8px; padding-top: 12px; font-size: 16px; font-weight: 700; color: #111827; }
.invoice-footer { border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; font-size: 12px; color: #9ca3af; line-height: 1.6; }
@media print { .print-hidden, .print\\:hidden { display: none !important; } body { background: white !important; } .invoice-wrapper { margin: 0; padding: 0; max-width: 100%; } .invoice-document { box-shadow: none; border-radius: 0; padding: 10mm 12mm; } @page { size: A4; margin: 10mm 12mm; } }
`;
