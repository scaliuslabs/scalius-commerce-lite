import { describe, expect, it } from "vitest";

import {
  createPurchaseTrackingPayload,
  formatOrderSuccessLabel,
  formatOrderSuccessPaymentMethod,
  getOrderSuccessStateKind,
  getOrderSuccessViewState,
  getOrderSuccessVisibleBalanceDue,
  shouldClearCheckoutCartForOrder,
} from "./order-success-state";
import type { OrderReceipt } from "./api/types";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

function makeOrder(overrides: Partial<OrderReceipt> = {}): OrderReceipt {
  return {
    id: "order_1",
    customerName: "Receipt Customer",
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

  it.each(["stripe", "sslcommerz", "polar"])(
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
      expect(getOrderSuccessViewState(order, ENGLISH_CHECKOUT_LANGUAGE_DATA).title).toBe("Confirming payment");
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
    ["incomplete", "unpaid", "stripe", "পেমেন্ট নিশ্চিত করা হচ্ছে", "অপরিশোধিত"],
    ["pending", "failed", "stripe", "পেমেন্ট সম্পন্ন হয়নি", "ব্যর্থ"],
    ["confirmed", "paid", "stripe", "অর্ডার নিশ্চিত হয়েছে", "পরিশোধিত"],
    ["processing", "paid", "stripe", "অর্ডার প্রস্তুত করা হচ্ছে", "পরিশোধিত"],
    ["shipped", "paid", "stripe", "অর্ডার পাঠানো হয়েছে", "পরিশোধিত"],
    ["delivered", "paid", "stripe", "অর্ডার ডেলিভারি হয়েছে", "পরিশোধিত"],
    ["completed", "paid", "stripe", "অর্ডার সম্পন্ন হয়েছে", "পরিশোধিত"],
    ["cancelled", "unpaid", "cod", "অর্ডার বাতিল হয়েছে", "ডেলিভারির সময় পরিশোধযোগ্য"],
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
