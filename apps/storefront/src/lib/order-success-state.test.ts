import { describe, expect, it } from "vitest";

import {
  codDueText,
  createPurchaseTrackingPayload,
  formatOrderSuccessLabel,
  formatOrderSuccessPaymentMethod,
  getOrderPaymentPresentation,
  getOrderSuccessNextSteps,
  getOrderSuccessStateKind,
  getOrderSuccessViewState,
  getOrderSuccessVisibleBalanceDue,
  isDigitalLinePreparing,
  isOrderStatusView,
  receiptGiftCardTenderLabel,
  shouldClearCheckoutCartForOrder,
} from "./order-success-state";
import type { OrderReceipt } from "./api/types";
import { canRetryOrderSuccessPayment } from "./order-success-payment-retry";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

function makeOrder(overrides: Partial<OrderReceipt> = {}): OrderReceipt {
  return {
    id: "order_1",
    customerName: "Receipt Customer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    accountLinked: false,
    shippingAddress: "House 1, Road 2",
    totalAmount: 1200,
    shippingCharge: 80,
    discountAmount: null,
    city: "city_1",
    zone: "zone_1",
    area: null,
    cityName: "Dhaka",
    zoneName: "Gulshan",
    areaName: null,
    status: "pending",
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    paidAmount: 0,
    balanceDue: 1200,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    items: [],
    supportRequests: [],
    supportRequestActions: [],
    supportRequestIntro: "Send a request and the store will review it.",
    ...overrides,
  };
}

describe("order success state", () => {
  it("uses buyer-facing payment provider labels", () => {
    expect(formatOrderSuccessLabel("partially_refunded", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe("Partially refunded");
    expect(formatOrderSuccessLabel("unknown_status", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe("Not available");
    expect(formatOrderSuccessPaymentMethod("stripe", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe("Card (Stripe)");
    expect(formatOrderSuccessPaymentMethod("sslcommerz", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe("Online payment (SSLCommerz)");
    expect(formatOrderSuccessPaymentMethod("stripe", BANGLA_CHECKOUT_LANGUAGE_DATA)).toBe("কার্ড (Stripe)");
  });

  it("treats COD pending/unpaid orders as placed", () => {
    const order = makeOrder({
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      status: "pending",
    });

    expect(getOrderSuccessStateKind(order)).toBe("order_placed");
    expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA)).toMatchObject({
      shouldFinalizeClientSide: true,
      title: "Order placed",
      paymentStatusLabel: "Due on delivery",
    });
  });

  it.each(["cancelled", "returned", "refunded", "partially_refunded"])(
    "does not tell buyers to pay a closed %s COD order",
    (status) => {
      const order = makeOrder({
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        status,
        balanceDue: 1200,
      });

      expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA)).toMatchObject({
        kind: "order_updated",
        paymentStatusLabel: "No payment due",
      });
      expect(getOrderSuccessVisibleBalanceDue(order)).toBe(0);
    },
  );

  it("keeps partial COD collection neutral and removes a closed order's payment obligation", () => {
    const order = makeOrder({ paymentStatus: "partial", paidAmount: 300, balanceDue: 900 });
    expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA)).toMatchObject({
      paymentStatusLabel: "Partially paid",
      paymentBadgeClass: "bg-slate-100 text-slate-800",
    });
    expect(getOrderSuccessVisibleBalanceDue(order)).toBe(900);
    expect(getOrderSuccessViewState({ ...order, status: "cancelled" }, ENGLISH_CHECKOUT_LANGUAGE_DATA))
      .toMatchObject({ paymentStatusLabel: "No payment due" });
  });

  it.each(["stripe", "sslcommerz"])(
    "holds %s orders in pending while local payment state is incomplete",
    (paymentMethod) => {
      const order = makeOrder({
        paymentMethod,
        paymentStatus: "unpaid",
        status: "incomplete",
        paidAmount: 0,
      });

      expect(getOrderSuccessStateKind(order)).toBe("payment_pending");
      expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA).shouldFinalizeClientSide).toBe(false);
    },
  );

  it("accepts full online payment only after the order is no longer incomplete", () => {
    expect(
      getOrderSuccessStateKind(makeOrder({
        paymentMethod: "sslcommerz",
        paymentStatus: "paid",
        status: "incomplete",
        paidAmount: 1200,
      })),
    ).toBe("payment_pending");

    expect(
      getOrderSuccessStateKind(makeOrder({
        paymentMethod: "sslcommerz",
        paymentStatus: "paid",
        status: "pending",
        paidAmount: 1200,
      })),
    ).toBe("order_placed");
  });

  it("accepts partial/deposit online payments after local confirmation", () => {
    const order = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "partial",
      status: "pending",
      paidAmount: 300,
      balanceDue: 900,
    });

    expect(getOrderSuccessStateKind(order)).toBe("order_placed");
    expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA).shouldFinalizeClientSide).toBe(true);
  });

  it.each(["confirmed", "processing", "shipped", "delivered", "completed"])(
    "keeps an active %s online order pending until payment is accepted",
    (status) => {
      const order = makeOrder({
        paymentMethod: "stripe",
        paymentStatus: "unpaid",
        status,
        paidAmount: 0,
      });

      expect(getOrderSuccessStateKind(order)).toBe("payment_pending");
      expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA).title).toBe("Payment pending");
    },
  );

  it("does not let a stale or forged callback query override durable payment truth", () => {
    const partial = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "partial",
      status: "confirmed",
      paidAmount: 300,
      balanceDue: 900,
    });
    expect(getOrderSuccessViewState(partial, ENGLISH_CHECKOUT_LANGUAGE_DATA, "failed").kind).toBe("order_updated");

    const paid = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "paid",
      status: "confirmed",
      paidAmount: 1200,
      balanceDue: 0,
    });
    expect(getOrderSuccessViewState(paid, ENGLISH_CHECKOUT_LANGUAGE_DATA, "failed").kind).toBe("order_updated");
  });

  it("keeps failed payments actionable without treating cancelled orders as payment failures", () => {
    expect(
      getOrderSuccessStateKind(makeOrder({
        paymentMethod: "stripe",
        paymentStatus: "failed",
        status: "pending",
      })),
    ).toBe("payment_issue");

    expect(
      getOrderSuccessStateKind(makeOrder({
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        status: "cancelled",
      })),
    ).toBe("order_updated");
  });

  it("clears only accepted checkout carts and preserves failed or cancelled carts", () => {
    expect(shouldClearCheckoutCartForOrder(makeOrder({
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      status: "pending",
    }))).toBe(true);
    expect(shouldClearCheckoutCartForOrder(makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "paid",
      paidAmount: 1200,
      balanceDue: 0,
      status: "pending",
    }))).toBe(true);
    expect(shouldClearCheckoutCartForOrder(makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "failed",
      status: "incomplete",
    }))).toBe(false);
    expect(shouldClearCheckoutCartForOrder(makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "unpaid",
      status: "cancelled",
    }))).toBe(false);
  });

  it("renders paid returned orders as a post-sale update without firing purchase finalization", () => {
    const view = getOrderSuccessViewState(makeOrder({
      paymentMethod: "cod",
      paymentStatus: "paid",
      status: "returned",
      paidAmount: 1200,
      balanceDue: 0,
    }), ENGLISH_CHECKOUT_LANGUAGE_DATA);

    expect(view).toMatchObject({
      kind: "order_updated",
      shouldFinalizeClientSide: false,
      title: "Order returned",
      orderStatusLabel: "Returned",
      paymentStatusLabel: "Paid",
    });
    expect(view.message).toBe("The return for order #order_1 has been recorded.");
    expect(view.message).not.toContain("payment is not complete");
  });

  it.each([
    ["pending", "unpaid", "cod", "অর্ডার দেওয়া হয়েছে", "ডেলিভারির সময় পরিশোধযোগ্য"],
    ["incomplete", "unpaid", "stripe", "পেমেন্ট অপেক্ষমাণ", "অপরিশোধিত"],
    ["pending", "failed", "stripe", "পেমেন্ট সম্পন্ন হয়নি", "ব্যর্থ"],
    ["confirmed", "paid", "stripe", "অর্ডার নিশ্চিত হয়েছে", "পরিশোধিত"],
    ["processing", "paid", "stripe", "অর্ডার প্রস্তুত করা হচ্ছে", "পরিশোধিত"],
    ["shipped", "paid", "stripe", "অর্ডার পাঠানো হয়েছে", "পরিশোধিত"],
    ["delivered", "paid", "stripe", "অর্ডার ডেলিভারি হয়েছে", "পরিশোধিত"],
    ["completed", "paid", "stripe", "অর্ডার সম্পন্ন হয়েছে", "পরিশোধিত"],
    ["cancelled", "unpaid", "cod", "অর্ডার বাতিল হয়েছে", "কোনো পেমেন্ট বাকি নেই"],
    ["refunded", "refunded", "stripe", "অর্ডারের টাকা ফেরত হয়েছে", "টাকা ফেরত হয়েছে"],
    ["returned", "paid", "cod", "অর্ডার ফেরত এসেছে", "পরিশোধিত"],
    ["partially_refunded", "partial", "stripe", "অর্ডারের কিছু টাকা ফেরত হয়েছে", "আংশিক পরিশোধিত"],
  ])(
    "localizes durable %s/%s receipt state in Bangla",
    (status, paymentStatus, paymentMethod, title, paymentStatusLabel) => {
      expect(getOrderSuccessViewState(makeOrder({
        status,
        paymentStatus,
        paymentMethod,
        paidAmount: paymentStatus === "paid" ? 1200 : paymentStatus === "partial" ? 300 : 0,
      }), BANGLA_CHECKOUT_LANGUAGE_DATA)).toMatchObject({
        title,
        paymentStatusLabel,
      });
    },
  );

  it("never presents refund or closed-order accounting as buyer debt", () => {
    for (const status of ["cancelled", "returned", "refunded", "partially_refunded"]) {
      expect(getOrderSuccessVisibleBalanceDue(makeOrder({
        status,
        paymentStatus: "unpaid",
        balanceDue: 1200,
      }))).toBe(0);
    }

    expect(getOrderSuccessVisibleBalanceDue(makeOrder({
      status: "pending",
      paymentStatus: "refunded",
      balanceDue: 1200,
    }))).toBe(0);
  });

  it("builds a non-PII analytics payload", () => {
    const payload = createPurchaseTrackingPayload(
      makeOrder({
        customerName: "Private Name",
        shippingAddress: "Private Address",
      }),
      [
        {
          id: "item_1",
          productId: "product_1",
          variantId: "variant_1",
          quantity: 2,
          price: 500,
          productName: "Product",
          productImage: null,
          variantLabel: null,
        },
      ],
    );

    expect(payload).toEqual({
      order: { id: "order_1", totalAmount: 1200 },
      items: [
        {
          productId: "product_1",
          variantId: "variant_1",
          quantity: 2,
          price: 500,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("Private Name");
    expect(JSON.stringify(payload)).not.toContain("Private Address");
  });
});

describe("order success receipt details", () => {
  it("names the order by its short number, falling back to the id", () => {
    const numbered = makeOrder({ orderNumber: 1001 });
    expect(getOrderSuccessViewState(numbered, ENGLISH_CHECKOUT_LANGUAGE_DATA).message)
      .toBe("We received order #1001.");
    expect(getOrderSuccessViewState(makeOrder(), ENGLISH_CHECKOUT_LANGUAGE_DATA).message)
      .toBe("We received order #order_1.");
  });

  it("reads a partly refunded payment as settled: no retry and nothing due", () => {
    const order = makeOrder({
      status: "delivered",
      paymentMethod: "sslcommerz",
      paymentStatus: "partially_refunded",
      paidAmount: 1200,
      balanceDue: 300,
    });
    const view = getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA);

    expect(view.kind).toBe("order_updated");
    expect(view.title).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptPartiallyRefundedTitleText);
    expect(view.paymentStatusLabel).toBe("Partially refunded");
    expect(getOrderSuccessVisibleBalanceDue(order)).toBe(0);
    expect(canRetryOrderSuccessPayment(order, view.kind, "failed")).toBe(false);
  });

  it("tells a COD buyer they'll get a call before the courier", () => {
    const order = makeOrder({ paymentMethod: "cod" });
    expect(getOrderSuccessNextSteps(order, "order_placed", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toEqual([
      "We'll call you to confirm your order, then hand it to the courier.",
    ]);
  });

  it("tells a digital-only order its downloads come here and by email, never that someone will call", () => {
    const copy = ENGLISH_CHECKOUT_LANGUAGE_DATA;
    const line = { quantity: 1, fulfillmentType: "digital" as const, fulfilledQuantity: 0 };
    const digital = { ...makeOrder({ paymentMethod: "sslcommerz", shippingMethodKind: null, requiresShipping: false }), items: [line] };
    expect(getOrderSuccessNextSteps(digital, "order_placed", copy)).toEqual([copy.orderReceiptNextStepsDigitalPaidText]);
    expect(getOrderSuccessNextSteps({ ...digital, paymentMethod: "cod" }, "order_placed", copy))
      .toEqual([copy.orderReceiptNextStepsDigitalText]);
    expect(getOrderSuccessNextSteps(digital, "order_placed", copy).join(" ")).not.toMatch(/arrange|call/i);
    // A service alongside the download is still arranged with the buyer.
    const mixed = { ...digital, items: [line, { quantity: 1, fulfillmentType: "service" as const, fulfilledQuantity: 0 }] };
    expect(getOrderSuccessNextSteps(mixed, "order_placed", copy)).toEqual([copy.orderReceiptNextStepsServicePaidText]);
  });

  it("says a paid download is being prepared until its units are delivered", () => {
    const paid = makeOrder({ paymentStatus: "paid", status: "processing" });
    const line = { quantity: 2, fulfillmentType: "digital" as const, fulfilledQuantity: 1 };
    expect(isDigitalLinePreparing(line, paid)).toBe(true);
    expect(isDigitalLinePreparing({ ...line, fulfilledQuantity: 2 }, paid)).toBe(false);
    expect(isDigitalLinePreparing(line, { ...paid, paymentStatus: "unpaid" })).toBe(false);
    expect(isDigitalLinePreparing(line, { ...paid, status: "cancelled" })).toBe(false);
    expect(isDigitalLinePreparing({ ...line, fulfillmentType: "ship" }, paid)).toBe(false);
  });

  it("never promises a courier for a pickup or a service order, and says what the cash is due on", () => {
    const copy = ENGLISH_CHECKOUT_LANGUAGE_DATA;
    const pickup = makeOrder({ paymentMethod: "cod", shippingMethodKind: "pickup", requiresShipping: false, shippingMethodDescription: "Same day, 2-3 hours" });
    const service = makeOrder({ paymentMethod: "cod", shippingMethodKind: null, requiresShipping: false });
    expect(getOrderSuccessNextSteps(pickup, "order_placed", copy)).toEqual([copy.orderReceiptNextStepsPickupCodText]);
    expect(getOrderSuccessNextSteps({ ...pickup, paymentMethod: "sslcommerz" }, "order_placed", copy))
      .toEqual([copy.orderReceiptNextStepsPickupPaidText]);
    expect(getOrderSuccessNextSteps(service, "order_placed", copy)).toEqual([copy.orderReceiptNextStepsServiceCodText]);
    for (const order of [pickup, service]) {
      expect(getOrderSuccessNextSteps(order, "order_placed", copy).join(" ")).not.toMatch(/courier/i);
    }
    expect(codDueText(pickup, copy)).toBe("Due at pickup");
    expect(codDueText(service, copy)).toBe("Due when the service is done");
    expect(codDueText(makeOrder({ paymentMethod: "cod" }), copy)).toBe("Due on delivery");
    expect(getOrderSuccessViewState({ ...pickup, paymentStatus: "unpaid" }, copy).paymentStatusLabel).toBe("Due at pickup");
  });

  it("tells an online-paid buyer their payment is confirmed, with the method's own estimate", () => {
    const order = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "paid",
      shippingMethodDescription: "Inside Dhaka, 2-3 days",
    });
    expect(getOrderSuccessNextSteps(order, "order_placed", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toEqual([
      "Your payment is confirmed. We'll pack your order and hand it to the courier.",
      "Delivery usually takes 2-3 days.",
    ]);
    expect(getOrderSuccessNextSteps(
      makeOrder({ shippingMethodDescription: "ঢাকার ভেতরে ১-২ দিন" }),
      "order_placed",
      BANGLA_CHECKOUT_LANGUAGE_DATA,
    )[1]).toBe("ডেলিভারিতে সাধারণত ১-২ দিন লাগে।");
  });

  it("never invents an estimate or next steps for orders the store has moved on", () => {
    const order = makeOrder({ shippingMethodDescription: "Disposable local smoke shipping method" });
    expect(getOrderSuccessNextSteps(order, "order_placed", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toHaveLength(1);
    expect(getOrderSuccessNextSteps(order, "order_updated", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toEqual([]);
    expect(getOrderSuccessNextSteps(order, "payment_pending", ENGLISH_CHECKOUT_LANGUAGE_DATA)).toEqual([]);
  });

  it("opens a tracked or moved-on order as a status page, but keeps the fresh confirmation", () => {
    const tracked = { requestedView: "status", freshCheckout: false };
    const later = { requestedView: null, freshCheckout: false };
    const fresh = { requestedView: null, freshCheckout: true };
    expect(isOrderStatusView("order_placed", tracked)).toBe(true);
    expect(isOrderStatusView("payment_pending", tracked)).toBe(true);
    expect(isOrderStatusView("order_updated", later)).toBe(true);
    expect(isOrderStatusView("order_updated", fresh)).toBe(false);
    expect(isOrderStatusView("order_placed", later)).toBe(false);
    expect(isOrderStatusView("payment_issue", { requestedView: "other", freshCheckout: false })).toBe(false);
  });
});

describe("gift-card orders on the receipt (Wave B §4.3)", () => {
  const copy = ENGLISH_CHECKOUT_LANGUAGE_DATA;
  // The receipt API's shape: succeeded tenders in commit order (a malformed one is skipped).
  const tenders = {
    giftCardTenders: [
      { last4: "7K2Q", amount: 400, amountMinor: 40_000 },
      { last4: "bad!", amount: 1, amountMinor: 100 },
    ],
  };

  it("reads a fully gift-card-paid order as paid and placed, with no payment to finish or retry", () => {
    const order = makeOrder({ paymentMethod: "gift_card", paymentStatus: "paid", paidAmount: 1200, balanceDue: 0 });
    const kind = getOrderSuccessStateKind(order);
    expect(kind).toBe("order_placed");
    const view = getOrderSuccessViewState(order, copy);
    expect(view.paymentStatusLabel).toBe("Paid");
    expect(view.title).toBe(copy.orderReceiptPlacedTitleText);
    expect(formatOrderSuccessPaymentMethod("gift_card", copy)).toBe("Gift card");
    expect(formatOrderSuccessPaymentMethod("gift_card", BANGLA_CHECKOUT_LANGUAGE_DATA)).toBe("গিফট কার্ড");
    expect(canRetryOrderSuccessPayment(order, kind, "failed")).toBe(false);
    expect(shouldClearCheckoutCartForOrder(order)).toBe(true);
    // Paid up front: the next steps speak of a paid order, not cash at the door.
    expect(getOrderSuccessNextSteps(order, kind, copy)[0]).toBe(copy.orderReceiptNextStepsPaidText);
  });

  it("shows a gift card plus cash on delivery as both tenders with the rest due at the door", () => {
    const order = { ...makeOrder({ paymentMethod: "cod", paymentStatus: "partial", paidAmount: 400, balanceDue: 800 }), ...tenders };
    const payment = getOrderPaymentPresentation(order, copy);
    expect(payment.giftCardTenders).toEqual([{ last4: "7K2Q", amount: 400 }]);
    expect(receiptGiftCardTenderLabel(payment.giftCardTenders[0]!, copy)).toBe("Gift card •••• 7K2Q");
    expect(payment.methodLabel).toBe("Gift card + Cash on delivery");
    expect(payment.statusLabel).toBe(copy.dueOnDeliveryText);
    expect(payment.balanceLabel).toBe(copy.dueOnDeliveryText);
    expect(payment.balanceDue).toBe(800);
    expect(getOrderSuccessStateKind(order)).toBe("order_placed");
    expect(getOrderSuccessNextSteps(order, "order_placed", copy)[0]).toBe(copy.orderReceiptNextStepsCodText);
  });

  it("still offers the gateway for the amount due when a card paid part and the gateway did not", () => {
    const order = {
      ...makeOrder({ status: "incomplete", paymentMethod: "sslcommerz", paymentStatus: "partial", paidAmount: 400, balanceDue: 800 }),
      ...tenders,
    };
    const kind = getOrderSuccessStateKind(order);
    expect(kind).toBe("payment_pending");
    expect(canRetryOrderSuccessPayment(order, kind, null)).toBe(true);
    const payment = getOrderPaymentPresentation(order, copy);
    expect(payment.methodLabel).toBe("Gift card + Online payment (SSLCommerz)");
    expect(payment.balanceLabel).toBe("Amount due");
    expect(payment.balanceDue).toBe(800);
  });

  it("reads no tenders from a receipt without the field", () => {
    const payment = getOrderPaymentPresentation(makeOrder(), copy);
    expect(payment.giftCardTenders).toEqual([]);
    expect(payment.methodLabel).toBe("Cash on delivery");
  });
});
