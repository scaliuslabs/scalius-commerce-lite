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
      taxAmountMinor: 0, createdAt: null,
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
      <button id="orderBuyAgain">Buy again</button><p id="orderBuyAgainMessage"></p>
      <ul id="orderItems"></ul><dl id="orderSummary"></dl>
      <h2 id="deliveryHeading">Shipping address</h2>
      <div id="orderAddress"></div><div id="orderNote" class="hidden"></div><div id="orderShipments"></div>
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
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Delivery · Inside Dhaka ৳80 Total ৳1,080");
    expect(document.querySelector("#orderItems a")?.getAttribute("href")).toBe("/products/bb-tee");
    expect(text("orderItems")).toBe("BB Tee Qty 2 × ৳500 ৳1,000");
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/BDT|Standard|notification|Accepted|Current status|Discount|VAT/);
  });

  it("lists each discount like the receipt, free delivery on the delivery line, and the buyer's note", () => {
    renderOrderDetail(detail(
      { discountAmount: 510, discountAmountMinor: 51_000, totalAmount: 570, totalAmountMinor: 57_000, notes: "দয়া করে ফোন করুন 🙏" },
      { discounts: [
        { promotionId: "p1", title: "R2SJPROD", code: "R2SJPROD", kind: "product", amount: 200, shippingAmount: 0 },
        { promotionId: "p2", title: "Eid sale", code: "R2SJORD10", kind: "order", amount: 230, shippingAmount: 0 },
        { promotionId: "p3", title: "Free delivery", code: "R2SJSHIP", kind: "shipping", amount: 0, shippingAmount: 80 },
      ] },
    ), null);
    expect(text("orderSummary")).toBe(
      "Subtotal ৳1,000 Delivery · Inside Dhaka ৳80 Free (R2SJSHIP) Discount · R2SJPROD −৳200 Discount · Eid sale (R2SJORD10) −৳230 Total ৳570",
    );
    expect(document.querySelector("#orderSummary s")?.textContent).toBe("৳80");
    expect(text("orderNote")).toBe("Your note দয়া করে ফোন করুন 🙏");
    expect(document.getElementById("orderNote")?.classList.contains("hidden")).toBe(false);
  });

  it("shows an order-level discount once, in the summary, with each item at its full price", () => {
    const order = detail(
      { discountAmount: 100, discountAmountMinor: 10_000, totalAmount: 980, totalAmountMinor: 98_000 },
      { discounts: [{ promotionId: "p2", title: "Eid sale", code: "EID10", kind: "order", amount: 100, shippingAmount: 0 }] },
    );
    order.items = [{ ...order.items[0]!, discountAmountMinor: 10_000, taxableAmountMinor: 90_000 }];
    renderOrderDetail(order, null);
    expect(text("orderItems")).toBe("BB Tee Qty 2 × ৳500 ৳1,000");
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Delivery · Inside Dhaka ৳80 Discount · Eid sale (EID10) −৳100 Total ৳980");
  });

  it("keeps an item-level saving on its item", () => {
    const order = detail(
      { discountAmount: 200, discountAmountMinor: 20_000, totalAmount: 880, totalAmountMinor: 88_000 },
      { discounts: [{ promotionId: "p1", title: "Tee deal", code: null, kind: "product", amount: 200, shippingAmount: 0 }] },
    );
    order.items = [{ ...order.items[0]!, discountAmountMinor: 20_000, taxableAmountMinor: 80_000 }];
    renderOrderDetail(order, null);
    expect(text("orderItems")).toBe("BB Tee Qty 2 × ৳500 Discount -৳200 ৳800");
  });

  it("shows a free pickup as Pickup and its location, and cash as Pay at pickup", () => {
    const order = detail({
      shippingAddress: null, city: null, zone: null, cityName: null, zoneName: null, areaName: null,
      shippingMethodName: "STAB Pickup Gulshan", shippingCharge: 0, shippingAmountMinor: 0, shippingMethodBaseAmountMinor: 0,
      totalAmount: 1000, totalAmountMinor: 100_000, balanceDue: 1000, expectedDelivery: null,
      requiresShipping: false, shippingMethodKind: "pickup", pickup: { address: "Gulshan 1", hours: null, readyAt: null },
    });
    renderOrderDetail(order, null);
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Pickup STAB Pickup Gulshan Total ৳1,000");
    expect(text("orderPayment")).toBe("Pay at pickup ৳1,000 due at pickup");
    expect(document.body.textContent).not.toMatch(/Shipping|Free|Cash on delivery/);
  });

  it("names cash on a service-only order Pay on service", () => {
    const order = detail({
      shippingAddress: null, city: null, zone: null, cityName: null, zoneName: null, areaName: null,
      shippingMethodId: null, shippingMethodName: null, shippingMethodBaseAmountMinor: null,
      shippingCharge: 0, shippingAmountMinor: 0, totalAmount: 1000, totalAmountMinor: 100_000, balanceDue: 1000,
      requiresShipping: false, shippingMethodKind: null, pickup: null,
    });
    renderOrderDetail(order, null);
    expect(text("orderPayment")).toBe("Pay on service ৳1,000 due when the service is done");
    expect(document.body.textContent).not.toContain("Cash on delivery");
  });

  it("shows a discount without allocations as one plain line, and no note block without a note", () => {
    renderOrderDetail(detail({ discountAmount: 150, discountAmountMinor: 15_000, totalAmountMinor: 93_000 }), null);
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Delivery · Inside Dhaka ৳80 Discount −৳150 Total ৳930");
    expect(document.getElementById("orderNote")?.classList.contains("hidden")).toBe(true);
  });

  it("shows each shipment's courier and a safe tracking link", () => {
    const shipment = {
      id: "s1", providerType: "manual", providerName: null, status: "in_transit", rawStatus: null, trackingId: "TRK-9",
      trackingUrl: "javascript:alert(1)", courierName: "Pathao", statusLabel: "On its way", lastChecked: null,
      updatedAt: "2026-09-24T03:00:00.000Z", createdAt: null, note: null, shipmentAmount: null, isFinalShipment: true,
    };
    renderOrderDetail(detail({}, { shipments: [shipment, { ...shipment, id: "s2", trackingUrl: "https://courier.example/t/TRK-9" }] }), null);
    const cards = document.querySelectorAll("#orderShipments article");
    expect(cards[0]?.textContent?.replace(/\s+/g, " ").trim()).toBe("On its way · Pathao Tracking ID TRK-9 Updated 24 Sep 2026, 9:00 AM");
    expect(cards[0]?.querySelector("a")).toBeNull();
    expect(cards[1]?.querySelector("a")?.getAttribute("href")).toBe("https://courier.example/t/TRK-9");
  });

  it("shows the recipient and one payment summary for cash on delivery", () => {
    renderOrderDetail(detail(), null);
    expect(text("orderAddress")).toBe("Recipient Name 01711-111111 House 1, Road 2 Mirpur, Dhaka Delivery method: Inside Dhaka");
    expect(text("orderPayment")).toBe("Cash on delivery ৳1,080 due on delivery");
    expect(document.getElementById("orderPaymentRecovery")?.classList.contains("hidden")).toBe(true);
  });

  it("shows each gift card that paid part, the remainder method and the amount due (Wave B §4.3)", () => {
    renderOrderDetail(detail(
      { paymentMethod: "cod", paymentStatus: "partial", paidAmount: 400, balanceDue: 680 },
      { giftCardTenders: [{ last4: "7K2Q", amount: 400, amountMinor: 40_000 }] } as Partial<AccountOrderDetail>,
    ), null);
    expect(text("orderPayment")).toBe("Gift card + Cash on delivery ৳680 due on delivery");
    const summary = text("orderSummary");
    expect(summary).toContain("Total ৳1,080");
    expect(summary).toContain("Gift card •••• 7K2Q −৳400");
    expect(summary).toContain("Due on delivery ৳680");
    expect(summary.indexOf("Total")).toBeLessThan(summary.indexOf("Gift card"));
  });

  it("reads an order its gift cards paid in full as paid by gift card", () => {
    renderOrderDetail(detail(
      { paymentMethod: "gift_card", paymentStatus: "paid", paidAmount: 1080, balanceDue: 0 },
      { giftCardTenders: [{ last4: "7K2Q", amount: 1080, amountMinor: 108_000 }] } as Partial<AccountOrderDetail>,
    ), null);
    expect(text("orderPayment")).toBe("Gift card Paid");
    expect(text("orderSummary")).toContain("Gift card •••• 7K2Q −৳1,080");
    expect(text("orderSummary")).not.toContain("due");
  });

  it("shows each line's buyer inputs, escaped, with the surcharge only when it costs extra", () => {
    const order = detail();
    order.items = [{
      ...order.items[0]!,
      fulfillmentType: "ship",
      fulfilledQuantity: 0,
      properties: [
        { key: "engraving", type: "text", label: "Engraving", value: "<b>Anika</b>", displayValue: "<b>Anika</b>", price: 200, priceMinor: 20_000 },
        { key: "gift_wrap", type: "checkbox", label: "Gift wrap", value: "true", displayValue: "Yes", price: 0, priceMinor: 0 },
      ],
    }];
    renderOrderDetail(order, null);
    // One shipping group keeps today's look: no group heading.
    expect(document.querySelector("#orderItems [data-order-line-group]")).toBeNull();
    expect(document.getElementById("orderItems")?.textContent?.replace(/\s+/g, " ").trim())
      .toBe("BB Tee Engraving: <b>Anika</b> (+৳200)Gift wrap: Yes Qty 2 × ৳500 ৳1,000");
    expect([...document.querySelectorAll("#orderItems li li")].map((row) => row.textContent))
      .toEqual(["Engraving: <b>Anika</b> (+৳200)", "Gift wrap: Yes"]);
    expect(document.querySelector("#orderItems b")).toBeNull();
    expect(document.querySelector("#orderItems a")?.getAttribute("href")).toBe("/products/bb-tee");
    expect(document.getElementById("orderItems")?.innerHTML).not.toMatch(/data-[a-z-]*="[^"]*Anika/);
  });

  it("groups a mixed order by how each line reaches the buyer, with where each group is", () => {
    const order = detail();
    const base = order.items[0]!;
    order.items = [
      { ...base, id: "svc", productName: "Fitting", productSlug: null, quantity: 1, fulfillmentType: "service", fulfilledQuantity: 1 },
      { ...base, id: "tee", fulfillmentType: "ship", quantity: 3, fulfilledQuantity: 1 },
      { ...base, id: "ebook", productName: "E-book", productSlug: null, quantity: 1, fulfillmentType: "digital", fulfilledQuantity: 0 },
    ];
    renderOrderDetail(order, null);
    const groups = [...document.querySelectorAll<HTMLElement>("#orderItems [data-order-line-group]")];
    expect(groups.map((group) => group.dataset.orderLineGroup)).toEqual(["ship", "service", "digital"]);
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual(["Delivery", "Services", "Digital items"]);
    expect(groups.map((group) => group.querySelector("h3 + p")?.textContent ?? "")).toEqual(["Preparing · 1 of 3", "Service done", ""]);
  });

  it("shows a pickup order's pickup facts instead of an address, and says Picked up once collected", () => {
    const pickup = { address: "Gulshan store, Road 11", hours: "10am–8pm", readyAt: null };
    const order = detail({
      shippingAddress: null, city: null, zone: null, cityName: null, zoneName: null, areaName: null,
      shippingMethodName: "Gulshan store", expectedDelivery: null,
      requiresShipping: false, shippingMethodKind: "pickup", pickup,
    });
    order.items = [{ ...order.items[0]!, fulfillmentType: "pickup", fulfilledQuantity: 0 }];
    renderOrderDetail(order, null);
    expect(text("deliveryHeading")).toBe("Pickup");
    expect(text("orderAddress")).toBe(
      "Recipient Name 01711-111111 Gulshan store Pick up at Gulshan store, Road 11 Hours: 10am–8pm We'll let you know when your order is ready to collect.",
    );
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Pickup · Gulshan store ৳80 Total ৳1,080");
    expect(text("orderItems")).toContain("Pickup Preparing");
    expect([...document.querySelectorAll("#orderProgress li")].map((step) => step.textContent?.replace(/\s+/g, " ").trim()))
      .toEqual(["Order placed (done)", "Confirmed", "Ready for pickup", "Picked up"]);
    expect(document.body.textContent).not.toMatch(/null|undefined|Delivery method/);
    // Nothing ships: the cancellation deadline is collection.
    expect(text("orderSupportActions")).toContain("Ask the store to review this order before it's collected.");
    expect(document.body.textContent).not.toContain("before it ships");

    const collected = detail({
      ...order.order, status: "delivered", statusLabel: "Delivered",
      pickup: { ...pickup, readyAt: "2026-09-24T05:00:00.000Z" },
    }, {
      timeline: [{ id: "t3", type: "order", status: "delivered", label: "Delivered", happenedAt: "2026-09-24T06:00:00.000Z", details: null }],
    });
    collected.items = [{ ...order.items[0]!, fulfilledQuantity: 2 }];
    renderOrderDetail(collected, null);
    expect(text("orderStatus")).toBe("Picked up");
    expect(text("orderTimeline")).toBe("Picked up 24 Sep 2026, 12:00 PM");
    expect(text("orderAddress")).not.toContain("We'll let you know");
    expect(document.body.textContent).not.toMatch(/Delivered/);
  });

  it("says no delivery is needed for a service-only order and completes it without Delivered", () => {
    const order = detail({
      status: "delivered", statusLabel: "Delivered",
      shippingAddress: null, city: null, zone: null, cityName: null, zoneName: null, areaName: null,
      shippingMethodId: null, shippingMethodName: null, shippingMethodBaseAmountMinor: null,
      shippingCharge: 0, shippingAmountMinor: 0, totalAmountMinor: 100_000,
      requiresShipping: false, shippingMethodKind: null, pickup: null,
    });
    order.items = [{ ...order.items[0]!, productName: "Fitting", fulfillmentType: "service", fulfilledQuantity: 2 }];
    renderOrderDetail(order, null);
    expect(text("deliveryHeading")).toBe("Delivery");
    expect(text("orderAddress")).toBe("Recipient Name 01711-111111 No delivery needed");
    expect(text("orderSummary")).toBe("Subtotal ৳1,000 Total ৳1,000");
    expect(text("orderStatus")).toBe("Completed");
    expect(text("orderItems")).toContain("Services Service done");
    expect(document.body.textContent).not.toMatch(/null|undefined|Delivered|Shipping address/);
  });

  it("replaces the tracker with the outcome of a cancelled order", () => {
    renderOrderDetail(detail({ status: "cancelled", statusLabel: "Cancelled" }, {
      progress: { steps: detail().progress!.steps, outcome: { key: "cancelled", label: "Cancelled", happenedAt: "2026-09-24T03:00:00.000Z" } },
    }), null);
    expect(text("orderProgress")).toBe("Cancelled 24 Sep 2026, 9:00 AM");
    expect(document.querySelector("#orderProgress ol")).toBeNull();
    expect(text("orderPayment")).toBe("Cash on delivery No payment due");
  });

  it("drops the 'send a request' line when a closed order offers no request", () => {
    renderOrderDetail(detail({ status: "cancelled", statusLabel: "Cancelled" }, { supportRequestActions: [] }), null);
    expect(document.getElementById("orderSupportIntro")?.hidden).toBe(true);
    expect(document.getElementById("orderSupportActions")?.hidden).toBe(true);
    renderOrderDetail(detail(), null);
    expect(document.getElementById("orderSupportIntro")?.hidden).toBe(false);
    expect(text("orderSupportIntro")).toBe("Need help with this order?");
    expect(document.getElementById("orderSupportActions")?.hidden).toBe(false);
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

  it("offers no Retry for an order that isn't in this account", async () => {
    api.getCustomerSession.mockResolvedValue({ authenticated: true });
    api.getCustomerOrderDetail.mockResolvedValueOnce({ success: false, status: 404, error: "Order not found" });
    await loadOrderDetail();
    expect(text("orderErrorTitle")).toBe("Order not found");
    // The attribute, not the class: `inline-flex` on the button outranks `.hidden`.
    expect(document.getElementById("orderRetry")?.hidden).toBe(true);
  });

  it("puts the lines that are still for sale back in the cart at today's price", async () => {
    const order = detail();
    order.items = [
      order.items[0]!,
      { ...order.items[0]!, id: "item_2", productId: "prod_gone", variantId: "sku_gone", productName: "Old Tee", productSlug: null },
      { ...order.items[0]!, id: "item_3", productId: "prod_3", variantId: "sku_red_m", quantity: 3, productName: "Polo", productSlug: "polo", variantLabel: "Red / M" },
    ];
    const validation = {
      valid: false,
      issues: [
        { index: 1, productId: "prod_gone", variantId: "sku_gone", code: "PRODUCT_UNAVAILABLE", action: "remove", message: "Gone", productName: "Old Tee", variantLabel: null },
        { index: 2, productId: "prod_3", variantId: "sku_red_m", code: "QUANTITY_UNAVAILABLE", action: "reduce_quantity", message: "Only 1 left", productName: "Polo", variantLabel: "Red / M" },
      ],
      items: [
        { index: 0, cartKey: "0", productId: "prod_1", variantId: "sku_default", quantity: 2, unitPrice: 550, productName: "BB Tee", variantLabel: null, freeDelivery: false, availableQuantity: null, productImageMediaId: null, productImage: null },
        { index: 2, cartKey: "2", productId: "prod_3", variantId: "sku_red_m", quantity: 3, unitPrice: 900, productName: "Polo", variantLabel: "Red / M", freeDelivery: true, availableQuantity: 1, productImageMediaId: "media_1", productImage: "https://cdn.example.test/polo.jpg" },
      ],
      subtotal: 0,
      hasFreeDeliveryProduct: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: validation })));
    vi.stubGlobal("fetch", fetchMock);
    const added: unknown[] = [];
    const listener = (event: Event) => added.push((event as CustomEvent).detail);
    document.addEventListener("add-to-cart", listener);
    renderOrderDetail(order, null);

    document.getElementById("orderBuyAgain")!.click();
    await vi.waitFor(() => expect(text("orderBuyAgainMessage")).toBe("Some items are no longer available, so they weren't added."));
    document.removeEventListener("add-to-cart", listener);
    vi.unstubAllGlobals();

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).items.map((item: { productId: string }) => item.productId))
      .toEqual(["prod_1", "prod_gone", "prod_3"]);
    expect(added).toEqual([
      { id: "prod_1", variantId: "sku_default", name: "BB Tee", price: 550, quantity: 2, slug: "bb-tee", image: undefined, imageMediaId: undefined, options: undefined, freeDelivery: false },
      { id: "prod_3", variantId: "sku_red_m", name: "Polo", price: 900, quantity: 1, slug: "polo", image: "https://cdn.example.test/polo.jpg", imageMediaId: "media_1", options: [{ name: "Variant", label: "Red / M" }], freeDelivery: true },
    ]);
  });

  it("says the store could not be reached and retries", async () => {
    api.getCustomerSession.mockResolvedValue({ authenticated: true });
    api.getCustomerOrderDetail.mockResolvedValueOnce({ success: false, status: 502, unavailable: true, error: "Proxy error" });
    await loadOrderDetail();
    expect(document.getElementById("orderError")?.classList.contains("hidden")).toBe(false);
    expect(text("orderErrorMessage")).toBe("We couldn't reach the store. Check your connection and try again.");
    expect(document.getElementById("orderRetry")?.hidden).toBe(false);
    api.getCustomerOrderDetail.mockResolvedValueOnce({ success: true, detail: detail() });
    document.getElementById("orderRetry")!.click();
    await vi.waitFor(() => expect(document.getElementById("orderContent")?.classList.contains("hidden")).toBe(false));
    expect(text("orderTitle")).toBe("Order #1001");
  });
});
