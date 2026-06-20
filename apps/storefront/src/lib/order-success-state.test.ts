import { describe, expect, it } from "vitest";

import {
  createPurchaseTrackingPayload,
  getOrderSuccessStateKind,
  getOrderSuccessViewState,
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
    ...overrides,
  };
}

describe("order success state", () => {
  it("treats COD pending/unpaid orders as placed", () => {
    const order = makeOrder({
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      status: "pending",
    });

    expect(getOrderSuccessStateKind(order)).toBe("order_placed");
    expect(getOrderSuccessViewState(order).shouldFinalizeClientSide).toBe(true);
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

  it("does not finalize failed or refunded receipts", () => {
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
    ).toBe("payment_issue");
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
          variantSize: null,
          variantColor: null,
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
