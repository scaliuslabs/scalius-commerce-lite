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
    expect(formatOrderSuccessLabel("cod")).toBe("Cash on Delivery");
    expect(formatOrderSuccessLabel("sslcommerz")).toBe("SSLCommerz");
    expect(formatOrderSuccessLabel("partially_refunded")).toBe("Partially Refunded");
    expect(formatOrderSuccessPaymentMethod("stripe")).toBe("Card (Stripe)");
    expect(formatOrderSuccessPaymentMethod("sslcommerz")).toBe("Online payment (SSLCommerz)");
  });

  it("treats COD pending/unpaid orders as placed", () => {
    const order = makeOrder({
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      status: "pending",
    });

    expect(getOrderSuccessStateKind(order)).toBe("order_placed");
    expect(getOrderSuccessViewState(order)).toMatchObject({
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
      expect(getOrderSuccessViewState(order).shouldFinalizeClientSide).toBe(false);
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
    expect(getOrderSuccessViewState(order).shouldFinalizeClientSide).toBe(true);
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
      expect(getOrderSuccessViewState(order).title).toBe("Confirming payment");
    },
  );

  it("uses a failed return as a truthful payment outcome only while money remains due", () => {
    const partial = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "partial",
      status: "confirmed",
      paidAmount: 300,
      balanceDue: 900,
    });
    expect(getOrderSuccessViewState(partial, "failed")).toMatchObject({
      kind: "payment_issue",
      title: "Payment not completed",
      shouldFinalizeClientSide: false,
    });

    const paid = makeOrder({
      paymentMethod: "sslcommerz",
      paymentStatus: "paid",
      status: "confirmed",
      paidAmount: 1200,
      balanceDue: 0,
    });
    expect(getOrderSuccessViewState(paid, "failed").kind).toBe("order_updated");
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
    }));

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
