import { describe, expect, it } from "vitest";
import type { InvoiceDocument } from "./snapshot";
import { renderPrintableInvoice } from "./printable-artifact";

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
      invoiceFooterText: "Thank you", invoiceLogoUrl: "https://example.com/private-logo.png", socialLinks: [],
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
        unitPriceMinor: 10_000, lineSubtotalMinor: 10_000,
        discountAmountMinor: 0, taxableAmountMinor: 10_000, taxAmountMinor: 0 }],
    },
  };
}

describe("printable invoice artifact", () => {
  it("renders one bounded self-contained document with escaped buyer data", () => {
    const artifact = renderPrintableInvoice(invoice(), "Asia/Dhaka");
    expect(artifact).toContain("<!doctype html>");
    // Issued 2023-11-14 22:13 UTC: the store's calendar day, not UTC's.
    expect(artifact).toContain("<p>2023-11-15</p>");
    expect(renderPrintableInvoice(invoice(), "America/New_York")).toContain("<p>2023-11-14</p>");
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

    const artifact = renderPrintableInvoice(document, "Asia/Dhaka");

    expect(artifact, "Asia/Dhaka").toContain("<span>Shipping</span>");
    expect(artifact).not.toContain("Delivery —");
  });

  it("prints each line's buyer inputs, escaped, with their surcharge", () => {
    const document = invoice();
    document.order.items[0]!.properties = [
      { label: "Engraving", displayValue: "<b>Anika</b> & co", priceMinor: 20_000 },
      { label: "Fit", displayValue: "Slim", priceMinor: 0 },
      { label: "Note", displayValue: "y".repeat(500), priceMinor: 0 },
    ];

    const artifact = renderPrintableInvoice(document, "Asia/Dhaka");

    expect(artifact, "Asia/Dhaka").toContain("<small>Engraving: &lt;b&gt;Anika&lt;/b&gt; &amp; co (+BDT 200.00)</small>");
    expect(artifact).toContain("<small>Fit: Slim</small>");
    expect(artifact).toContain(`<small>Note: ${"y".repeat(199)}…</small>`);
    expect(artifact).not.toContain("<b>Anika</b>");
  });

  it("prints net terms with the due day on the store calendar", () => {
    const document = invoice();
    document.order.paymentTerms = { kind: "net", days: 30, dueAt: "2023-12-14T20:00:00.000Z" };

    expect(renderPrintableInvoice(document, "Asia/Dhaka")).toContain("<p><strong>Terms: Net 30</strong> · due 2023-12-15</p>");
    expect(renderPrintableInvoice(invoice(), "Asia/Dhaka")).not.toContain("Terms:");
  });

  it("prints a free gift at zero with its price struck, as the payment counts it", () => {
    const document = invoice();
    document.order.items.push({
      id: "oi_gift", productId: "p_gift", variantId: "v_gift", quantity: 1, price: 1200, productName: "Gift mug",
      variantLabel: null, unitPriceMinor: 120_000, lineSubtotalMinor: 120_000,
      discountAmountMinor: 120_000, taxableAmountMinor: 0, taxAmountMinor: 0,
    });

    const artifact = renderPrintableInvoice(document, "Asia/Dhaka");

    expect(artifact).toContain("<td><s>BDT 1,200.00</s> BDT 0.00</td>");
    expect(artifact.match(/<s>BDT 1,200\.00<\/s> BDT 0\.00/g)).toHaveLength(2);
    // A paid line keeps its price.
    expect(artifact).not.toContain("<s>BDT 100.00</s>");
  });

  it("fails closed when the artifact cannot fit the operation result bound", () => {
    const document = invoice();
    document.order.items = Array.from({ length: 1_000 }, (_, index) => ({
      ...document.order.items[0]!,
      id: `oi_${index}`,
      productName: "x".repeat(200),
    }));
    expect(() => renderPrintableInvoice(document, "Asia/Dhaka")).toThrow("safe artifact size limit");
  });
});
