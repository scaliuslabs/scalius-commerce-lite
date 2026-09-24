// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import { InvoiceSheet, type InvoiceDocument } from "./InvoiceSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const document_ = {
  status: "draft",
  invoiceNumber: null,
  issuedAt: null,
  businessInfo: { companyName: "Dhaka Threads", legalName: "" },
  order: {
    id: "ord_1", orderNumber: 1049, createdAt: 1_783_000_000, customerName: "Rahim Uddin",
    customerPhone: "+8801712349105", customerEmail: null, shippingAddress: "House 4, Road 2",
    totalAmount: 2480, shippingCharge: 80, discountAmount: 0, refundedAmount: 1600, discounts: [],
    paymentMethod: "cod", paymentStatus: "partially_refunded",
    items: [{ id: "i1", productName: "Kurta", variantLabel: null, quantity: 3, price: 800, returnedQuantity: 2 }],
  },
} as unknown as InvoiceDocument;

describe("InvoiceSheet", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("prints a plain invoice: local phone, returned lines, refund and net, no draft heading", async () => {
    await act(async () => root.render(<InvoiceSheet document={document_} />));
    expect(host.textContent).toContain("01712349105");
    expect(host.textContent).not.toContain("+880");
    expect(host.querySelector("h2")?.textContent).toBe(en["invoice.title"]);
    expect(host.textContent).not.toMatch(/draft|not issued/i);
    expect(host.querySelector("td")?.textContent).toContain(en["items.returned"].replace("{count}", "2"));
    const totals = [...host.querySelectorAll(".invoice-totals div")].map((row) => row.textContent);
    expect(totals).toContain(`${en["payment.refunded"]}−1,600`);
    expect(totals).toContain(`${en["payment.net"]}880`);
  });
});
