// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckoutOrderError, createOrder } from "./create-order";

const checkoutData = {
  checkoutRequestId: "checkout_req_test",
  customerName: "Test Customer",
  customerPhone: "+8801700000000",
  customerEmail: "customer@example.com",
  shippingAddress: "123 Test Street, Dhaka",
  city: "city_1",
  zone: "zone_1",
  area: "",
  notes: "",
  shippingCharge: "60",
  cartItems: JSON.stringify({
    "prod_1:default": {
      id: "prod_1",
      variantId: "default",
      quantity: 2,
      price: 150,
      name: "Cotton Panjabi",
      size: "M",
      color: "Blue",
    },
  }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOrder", () => {
  it("sends cart keys and buyer-facing line metadata to the order proxy", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      data: {
        id: "ord_1",
        receiptToken: "receipt_1",
      },
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createOrder(checkoutData, "cod");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        cartKey: "prod_1:default",
        productId: "prod_1",
        variantId: null,
        quantity: 2,
        price: 150,
        productName: "Cotton Panjabi",
        variantLabel: "M / Blue",
      }),
    ]);
  });

  it("preserves structured cart issues on late order creation failure", async () => {
    const issue = {
      index: 0,
      cartKey: "prod_1:default",
      productId: "prod_1",
      variantId: null,
      code: "PRODUCT_UNAVAILABLE" as const,
      action: "remove" as const,
      message: "Cotton Panjabi is no longer available.",
      productName: "Cotton Panjabi",
      variantLabel: null,
      requestedQuantity: 2,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Some items in your cart need attention.",
      details: { itemIssues: [issue] },
    }), { status: 400 })));

    try {
      await createOrder(checkoutData, "cod");
      throw new Error("Expected createOrder to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutOrderError);
      expect(error).toMatchObject({
        name: "CheckoutOrderError",
        status: 400,
        cartIssues: [issue],
      });
      expect((error as CheckoutOrderError).cartIssues).toEqual([issue]);
    }
  });
});
