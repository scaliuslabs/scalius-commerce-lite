import { describe, expect, it } from "vitest";
import type { InvoiceDocument } from "./invoice-snapshot";
import { renderPrintableInvoice } from "./invoice-printable-artifact";

function invoice(): InvoiceDocument {
  return {
    status: "issued",
    invoiceNumber: "INV-00001",
    invoiceNum: 1,
    issuedAt: 1_700_000_000,
    contentHash: "a".repeat(64),
    renderVersion: "invoice-v1",
    orderVersion: 1,
    businessInfo: {
      companyName: "Scalius <Store>", legalName: "", addressLine1: "Road 1",
      addressLine2: "", city: "Dhaka", stateRegion: "", postalCode: "", country: "BD",
      phone: "0123", email: "merchant@example.com", taxId: "", invoicePrefix: "INV",
      invoiceFooterText: "Thank you", invoiceLogoUrl: "https://example.com/private-logo.png",
    },
    order: {
      id: "ord_1", version: 1, customerName: "Buyer <script>", customerPhone: "01700",
      customerEmail: null, customerId: null, shippingAddress: "House & road", city: null,
      zone: null, area: null, cityName: "Dhaka", zoneName: null, areaName: null,
      totalAmount: 110, shippingCharge: 10, discountAmount: 0, currencyCode: "BDT",
      currencyDecimalPlaces: 2, subtotalAmountMinor: 10_000, shippingAmountMinor: 1_000,
      shippingMethodId: "shipping_standard", shippingMethodName: "Standard delivery",
      shippingMethodDescription: "Delivered within 2–3 business days",
      shippingMethodBaseAmountMinor: 1_000, shippingFeeWaived: false,
      discountAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 11_000, taxLabel: "Tax",
      pricesIncludeTax: true, status: "confirmed", paymentStatus: "paid", paymentMethod: "cod",
      fulfillmentStatus: "pending", paidAmount: 110, balanceDue: 0, createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000, items: [{ id: "oi_1", productId: "p1", variantId: "v1",
        quantity: 1, price: 100, productName: "Item", variantLabel: null,
        fulfillmentStatus: "pending", unitPriceMinor: 10_000, lineSubtotalMinor: 10_000,
        discountAmountMinor: 0, taxableAmountMinor: 10_000, taxAmountMinor: 0 }],
    },
  };
}

describe("printable invoice artifact", () => {
  it("renders one bounded self-contained document with escaped buyer data", () => {
    const artifact = renderPrintableInvoice(invoice());
    expect(artifact).toContain("<!doctype html>");
    expect(artifact).toContain("Scalius &lt;Store&gt;");
    expect(artifact).toContain("Buyer &lt;script&gt;");
    expect(artifact).toContain("BDT 110.00");
    expect(artifact).toContain("Delivery — Standard delivery");
    expect(artifact).toContain("Delivered within 2–3 business days");
    expect(artifact).not.toContain("private-logo.png");
    expect(new TextEncoder().encode(artifact).byteLength).toBeLessThanOrEqual(65_536);
  });

  it("keeps the historical shipping label when no method snapshot exists", () => {
    const document = invoice();
    document.order.shippingMethodId = null;
    document.order.shippingMethodName = null;
    document.order.shippingMethodDescription = null;
    document.order.shippingMethodBaseAmountMinor = null;
    document.order.shippingFeeWaived = null;

    const artifact = renderPrintableInvoice(document);

    expect(artifact).toContain("<span>Shipping</span>");
    expect(artifact).not.toContain("Delivery —");
  });

  it("fails closed when the artifact cannot fit the operation result bound", () => {
    const document = invoice();
    document.order.items = Array.from({ length: 1_000 }, (_, index) => ({
      ...document.order.items[0]!,
      id: `oi_${index}`,
      productName: "x".repeat(200),
    }));
    expect(() => renderPrintableInvoice(document)).toThrow("safe artifact size limit");
  });
});
