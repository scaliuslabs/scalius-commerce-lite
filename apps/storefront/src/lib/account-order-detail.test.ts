// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerPaymentRecovery } from "./api/customer-auth";
import type { AccountOrderDetail } from "./account-order-detail";

const api = vi.hoisted(() => ({
  getCustomerSession: vi.fn(),
  getCustomerOrderDetail: vi.fn(),
  createCustomerOrderSupportRequest: vi.fn(),
  createCustomerOrderPaymentSession: vi.fn(),
  getCheckoutConfig: vi.fn(),
}));
vi.mock("./api/customer-auth", () => ({
  getCustomerSession: api.getCustomerSession,
  getCustomerOrderDetail: api.getCustomerOrderDetail,
  createCustomerOrderSupportRequest: api.createCustomerOrderSupportRequest,
  createCustomerOrderPaymentSession: api.createCustomerOrderPaymentSession,
}));
vi.mock("./api/checkout", () => ({ getCheckoutConfig: api.getCheckoutConfig }));
vi.mock("./product-media", () => ({ getProductImageUrl: () => "/placeholder-product.svg" }));

const { bindOrderDetailPage, loadOrderDetail, renderOrderDetail } = await import("./account-order-detail");

/** Each leaf element's text, space-joined, the way a reader scans the card. */
const text = (id: string) => [...(document.getElementById(id)?.querySelectorAll("*") ?? [])]
  .filter((node) => node.children.length === 0)
  .map((node) => node.textContent?.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join(" ") || (document.getElementById(id)?.textContent?.trim() ?? "");

function recovery(overrides: Partial<CustomerPaymentRecovery> = {}): CustomerPaymentRecovery {
  return {
    eligible: false, gateway: "sslcommerz", paymentType: "full", amountDue: 0, label: "Retry payment",
    reason: null, requiresCardForm: false, hostedRedirect: true, ...overrides,
  };
}

function detail(overrides: Partial<AccountOrderDetail["order"]> = {}, extra: Partial<AccountOrderDetail> = {}): AccountOrderDetail {
  return {
    order: {
      id: "JJEHCFQ3C1JJ35GX", orderNumber: 1001, invoiceNumber: null, status: "confirmed", statusLabel: "Confirmed",
      totalAmount: 1080, paidAmount: 0, balanceDue: 1080, shippingCharge: 80, discountAmount: 0,
      currencyCode: "BDT", currencyDecimalPlaces: 2, subtotalAmountMinor: 100_000, shippingAmountMinor: 8_000,
      discountAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 108_000, taxLabel: "VAT", pricesIncludeTax: false,
      shippingMethodId: "ship_1", shippingMethodName: "Inside Dhaka", shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: 8_000, shippingFeeWaived: false,
      paymentStatus: "unpaid", paymentMethod: "cod", fulfillmentStatus: "pending", expectedDelivery: "1-2 days",
      customerName: "Recipient Name", customerPhone: "+8801711111111",
      shippingAddress: "House 1, Road 2", city: "city_1", zone: "zone_1", area: null,
      cityName: "Dhaka", zoneName: "Mirpur", areaName: null, notes: null,
      createdAt: "2026-09-23T23:46:00.000Z", updatedAt: null,
      ...overrides,
    },
    items: [{
      id: "item_1", productId: "prod_1", variantId: "sku_default", quantity: 2, price: 500, productName: "BB Tee",
      productSlug: "bb-tee", productImage: null, variantLabel: null, unitPrice: 500, lineTotal: 1000,
      unitPriceMinor: 50_000, lineSubtotalMinor: 100_000, discountAmountMinor: 0, taxableAmountMinor: 100_000,
      taxAmountMinor: 0, fulfillmentStatus: "pending", createdAt: null,
    }],
    shipments: [], payments: [], refundAttempts: [], activeRefundOperation: null,
    supportRequests: [],
    supportRequestActions: [{ type: "cancel_pre_shipment", label: "Request cancellation", description: "Ask the store to review this order before it ships.", eligible: true, disabledReason: null }],
    supportRequestIntro: "Need help with this order?",
    paymentPlan: null,
    cod: { codStatus: "pending", deliveryAttempts: 0, failureReason: null, collectedAmount: null, receiptUrl: null, lastAttemptAt: null, collectedAt: null, updatedAt: null },
    paymentRecovery: recovery(),
    progress: {
      steps: [
        { key: "placed", label: "Order placed", done: true, happenedAt: "2026-09-23T23:46:00.000Z" },
        { key: "confirmed", label: "Confirmed", done: true, happenedAt: "2026-09-24T02:00:00.000Z" },
        { key: "shipped", label: "On its way", done: false, happenedAt: null },
        { key: "delivered", label: "Delivered", done: false, happenedAt: null },
      ],
      outcome: null,
    },
    timeline: [
      { id: "t2", type: "order", status: "confirmed", label: "Confirmed", happenedAt: "2026-09-24T02:00:00.000Z", details: "The store confirmed your order." },
      { id: "t1", type: "order", status: "placed", label: "Order placed", happenedAt: "2026-09-23T23:46:00.000Z", details: "We received your order." },
    ],
    ...extra,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getCheckoutConfig.mockResolvedValue({ gateways: [], unavailable: true });
  document.body.innerHTML = `<section data-order-detail-page data-order-id="JJEHCFQ3C1JJ35GX">
    <div id="orderLoading"></div><div id="orderUnauthenticated" class="hidden"></div>
    <div id="orderError" class="hidden"><h1 id="orderErrorTitle"></h1><p id="orderErrorMessage"></p><button id="orderRetry">Retry</button></div>
    <div id="orderContent" class="hidden">
      <h1 id="orderTitle"></h1><span id="orderStatus"></span><p id="orderSubtitle"></p>
      <div id="orderPaymentReturnNotice" class="hidden"></div><div id="orderRefundNotice" class="hidden"></div>
      <div id="orderProgress"></div><p id="orderExpectedDelivery" class="hidden"></p><ol id="orderTimeline"></ol>
      <ul id="orderItems"></ul><dl id="orderSummary"></dl>
      <div id="orderAddress"></div><div id="orderShipments"></div>
      <div id="orderPayment"></div>
      <div id="orderPaymentRecovery" class="hidden"><h3 id="orderPaymentRecoveryTitle"></h3><p id="orderPaymentRecoveryDescription"></p>
        <div id="orderPaymentRecoveryMethods"></div><div id="accountStripeSection" class="hidden"><p id="accountStripeError"></p></div>
        <p id="orderPaymentRecoveryMessage"></p><button id="orderPaymentRecoveryButton"></button></div>
      <p id="orderSupportIntro"></p><div id="orderSupportActions"></div><div id="orderSupportRequests"></div>
      <div id="orderSupportForm" class="hidden"><h3 id="orderSupportFormTitle"></h3><div id="orderSupportReasons"></div>
        <textarea id="orderSupportMessage"></textarea><p id="orderSupportFormError" class="hidden"></p>
        <button id="orderSupportCancel">Cancel</button><button id="orderSupportSubmit">Submit request</button></div>
    </div>
  </section>`;
  bindOrderDetailPage();
});

describe("account order detail", () => {
  it("shows the order in buyer words: number, one tracker, dated updates and no zero or default lines", () => {
    renderOrderDetail(detail(), null);
    expect(text("orderTitle")).toBe("Order #1001");
    expect(text("orderStatus")).toBe("Confirmed");
    expect(text("orderSubtitle")).toBe("Placed 24 Sep 2026, 5:46 AM");
    const steps = [...document.querySelectorAll("#orderProgress li")];
    expect(steps.map((step) => step.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Order placed (done)", "Confirmed", "On its way", "Delivered",
    ]);
    expect(steps[1]?.getAttribute("aria-current")).toBe("step");
    expect(text("orderExpectedDelivery")).toBe("Expected delivery: 1-2 days");
    expect(text("orderTimeline")).toBe("Confirmed The store confirmed your order. 24 Sep 2026, 8:00 AM Order placed We received your order. 24 Sep 2026, 5:46 AM");
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Delivery (Inside Dhaka) ৳80 Total ৳1,080");
    expect(document.querySelector("#orderItems a")?.getAttribute("href")).toBe("/products/bb-tee");
    expect(text("orderItems")).toBe("BB Tee Qty 2 × ৳500 ৳1,000");
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/BDT|Standard|notification|Accepted|Current status|Discount|VAT/);
  });

  it("shows the recipient and one payment summary for cash on delivery", () => {
    renderOrderDetail(detail(), null);
    expect(text("orderAddress")).toBe("Recipient Name 01711-111111 House 1, Road 2 Mirpur, Dhaka Delivery method: Inside Dhaka");
    expect(text("orderPayment")).toBe("Cash on delivery ৳1,080 due on delivery");
    expect(document.getElementById("orderPaymentRecovery")?.classList.contains("hidden")).toBe(true);
  });

  it("replaces the tracker with the outcome of a cancelled order", () => {
    renderOrderDetail(detail({ status: "cancelled", statusLabel: "Cancelled" }, {
      progress: { steps: detail().progress!.steps, outcome: { key: "cancelled", label: "Cancelled", happenedAt: "2026-09-24T03:00:00.000Z" } },
    }), null);
    expect(text("orderProgress")).toBe("Cancelled 24 Sep 2026, 9:00 AM");
    expect(document.querySelector("#orderProgress ol")).toBeNull();
    expect(text("orderPayment")).toBe("Cash on delivery No payment due");
  });

  it("never offers payment for a refunded or partly refunded order", () => {
    for (const paymentStatus of ["refunded", "partially_refunded"]) {
      renderOrderDetail(detail(
        { paymentMethod: "sslcommerz", paymentStatus, status: "delivered", balanceDue: 400, paidAmount: 680 },
        { paymentRecovery: recovery({ eligible: true, amountDue: 400 }) },
      ), { gateways: [], unavailable: true } as never);
      expect(document.getElementById("orderPaymentRecovery")?.classList.contains("hidden")).toBe(true);
      expect(text("orderPayment")).not.toMatch(/due/);
    }
  });

  it("offers online payment recovery when the backend allows it", () => {
    renderOrderDetail(detail(
      { paymentMethod: "sslcommerz", paymentStatus: "failed", status: "incomplete", statusLabel: "Awaiting payment" },
      { paymentRecovery: recovery({ eligible: true, amountDue: 1080 }) },
    ), { gateways: [], unavailable: true } as never);
    expect(document.getElementById("orderPaymentRecovery")?.classList.contains("hidden")).toBe(false);
    expect(text("orderPaymentRecoveryDescription")).toContain("Amount due: ৳1,080.");
    expect(text("orderPayment")).toContain("Payment needs attention");
  });

  it("asks for a preset reason and sends it with the optional note", async () => {
    renderOrderDetail(detail(), null);
    document.querySelector<HTMLButtonElement>('[data-support-request-type="cancel_pre_shipment"]')!.click();
    expect(document.getElementById("orderSupportForm")?.classList.contains("hidden")).toBe(false);
    const reasons = [...document.querySelectorAll<HTMLInputElement>('input[name="orderSupportReason"]')].map((input) => input.value);
    expect(reasons).toEqual(["Ordered by mistake", "Found a better price", "Delivery is too slow", "Need to change the address or items", "Other"]);

    document.getElementById("orderSupportSubmit")!.click();
    expect(text("orderSupportFormError")).toBe("Choose a reason.");
    document.querySelector<HTMLInputElement>('input[value="Other"]')!.checked = true;
    document.getElementById("orderSupportSubmit")!.click();
    expect(text("orderSupportFormError")).toBe("Tell the store what you need.");
    expect(api.createCustomerOrderSupportRequest).not.toHaveBeenCalled();

    api.createCustomerOrderSupportRequest.mockResolvedValue({ success: false, status: 502, error: "Proxy error" });
    document.querySelector<HTMLInputElement>('input[value="Ordered by mistake"]')!.checked = true;
    (document.getElementById("orderSupportMessage") as HTMLTextAreaElement).value = "  Wrong size  ";
    document.getElementById("orderSupportSubmit")!.click();
    await vi.waitFor(() => expect(text("orderSupportFormError")).toBe("We couldn't reach the store. Check your connection and try again."));
    expect(api.createCustomerOrderSupportRequest).toHaveBeenCalledWith("JJEHCFQ3C1JJ35GX", {
      type: "cancel_pre_shipment", reason: "Ordered by mistake", message: "Wrong size",
    });
  });

  it("says the store could not be reached and retries", async () => {
    api.getCustomerSession.mockResolvedValue({ authenticated: true });
    api.getCustomerOrderDetail.mockResolvedValueOnce({ success: false, status: 502, unavailable: true, error: "Proxy error" });
    await loadOrderDetail();
    expect(document.getElementById("orderError")?.classList.contains("hidden")).toBe(false);
    expect(text("orderErrorMessage")).toBe("We couldn't reach the store. Check your connection and try again.");
    api.getCustomerOrderDetail.mockResolvedValueOnce({ success: true, detail: detail() });
    document.getElementById("orderRetry")!.click();
    await vi.waitFor(() => expect(document.getElementById("orderContent")?.classList.contains("hidden")).toBe(false));
    expect(text("orderTitle")).toBe("Order #1001");
  });
});
