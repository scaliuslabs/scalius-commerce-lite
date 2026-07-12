import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getCities: vi.fn(),
  getZones: vi.fn(),
  getAreas: vi.fn(),
  getProductBySlug: vi.fn(),
  getShippingMethods: vi.fn(),
  validateDiscount: vi.fn(),
  deleteAbandonedCheckout: vi.fn(),
  validateCartItems: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  createOrder: mocks.createOrder,
  getCities: mocks.getCities,
  getZones: mocks.getZones,
  getAreas: mocks.getAreas,
  getProductBySlug: mocks.getProductBySlug,
  getShippingMethods: mocks.getShippingMethods,
  validateDiscount: mocks.validateDiscount,
  deleteAbandonedCheckout: mocks.deleteAbandonedCheckout,
}));

vi.mock("@/lib/api/orders", () => ({
  validateCartItems: mocks.validateCartItems,
}));

import { processOrder } from "./server";

function buildCodFormData(): FormData {
  const formData = new FormData();
  formData.set("customerName", "Buyer");
  formData.set("customerPhone", "+8801712345678");
  formData.set("customerEmail", "buyer@example.com");
  formData.set("shippingAddress", "House 1, Dhaka");
  formData.set("city", "city_1");
  formData.set("zone", "zone_1");
  formData.set("area", "");
  formData.set("shippingLocation", "ship_1");
  formData.set("checkoutId", "chk_session_test_123456");
  formData.set("notes", "");
  formData.set("cartItems", JSON.stringify({
    line_1: {
      id: "product-1",
      slug: "product-1",
      name: "Product 1",
      price: 100,
      quantity: 1,
      variantId: "variant_1",
    },
  }));
  return formData;
}

describe("cart server order processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCities.mockResolvedValue([{ id: "city_1", name: "Dhaka" }]);
    mocks.getZones.mockResolvedValue([{ id: "zone_1", name: "Mirpur" }]);
    mocks.getAreas.mockResolvedValue([]);
    mocks.getShippingMethods.mockResolvedValue([{ id: "ship_1", fee: 60 }]);
    mocks.getProductBySlug.mockResolvedValue({
      product: {
        id: "product_1",
        name: "Product 1",
        price: 100,
        discountedPrice: 100,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
      },
      variants: [
        {
          id: "variant_1",
          price: 100,
          stock: 5,
          reservedStock: 0,
          discountType: null,
          discountAmount: null,
          discountPercentage: null,
        },
      ],
    });
    mocks.createOrder.mockResolvedValue({
      success: true,
      orderId: "order_1",
      receiptToken: "receipt_1",
    });
    mocks.validateCartItems.mockResolvedValue({
      success: true,
      data: {
        valid: true,
        issues: [],
        items: [
          {
            index: 0,
            cartKey: "line_1",
            productId: "product-1",
            variantId: "variant_1",
            quantity: 1,
            unitPrice: 100,
            productName: "Product 1",
            variantLabel: null,
            freeDelivery: false,
            availableQuantity: 5,
          },
        ],
        subtotal: 100,
        hasFreeDeliveryProduct: false,
        delivery: {
          shippingCharge: 60,
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: null,
        },
      },
    });
  });

  it("forwards the authenticated customer session token to COD order creation", async () => {
    const result = await processOrder(buildCodFormData(), {
      customerSessionToken: "session_123",
    });

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutRequestId: "chk_session_test_123456",
        paymentMethod: "cod",
        customerPhone: "+8801712345678",
        shippingMethodId: "ship_1",
        cityName: "Dhaka",
        zoneName: "Mirpur",
        shippingCharge: 60,
        items: [
          expect.objectContaining({
            productId: "product-1",
            variantId: "variant_1",
            price: 100,
          }),
        ],
      }),
      { customerSessionToken: "session_123" },
    );
    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          cartKey: "line_1",
          productId: "product-1",
          variantId: "variant_1",
          price: 100,
        }),
      ],
      {
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: "ship_1",
      },
    );
  });

  it("preserves ordered merchant option labels during authoritative validation", async () => {
    const formData = buildCodFormData();
    formData.set("cartItems", JSON.stringify({
      line_1: {
        id: "product-1",
        name: "Product 1",
        price: 100,
        quantity: 1,
        variantId: "variant_1",
        options: [
          { name: "Weight", label: "2KG" },
          { name: "Roast", label: "Medium" },
          { name: "Packaging", label: "Gift box" },
        ],
      },
    }));

    await processOrder(formData);

    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [expect.objectContaining({ variantLabel: "2KG / Medium / Gift box" })],
      expect.any(Object),
    );
  });

  it("does not wait for abandoned checkout cleanup after successful COD order creation", async () => {
    mocks.deleteAbandonedCheckout.mockReturnValueOnce(new Promise<void>(() => undefined));

    const result = await Promise.race([
      processOrder(buildCodFormData()),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 20)),
    ]);

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.deleteAbandonedCheckout).toHaveBeenCalledWith("chk_session_test_123456");
  });

  it("uses waitUntil for abandoned checkout cleanup when a Worker context is provided", async () => {
    const waitUntil = vi.fn();
    mocks.deleteAbandonedCheckout.mockReturnValueOnce(new Promise<void>(() => undefined));

    const result = await Promise.race([
      processOrder(buildCodFormData(), { waitUntil }),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 20)),
    ]);

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it.each([
    ["missing", undefined],
    ["synthetic default", "default"],
  ])("rejects a %s variant before cart validation or order creation", async (_label, variantId) => {
    const formData = buildCodFormData();
    const cartItem: Record<string, unknown> = {
      id: "simple_product",
      slug: "simple-product",
      name: "Simple Product",
      price: 150,
      quantity: 2,
    };
    if (variantId !== undefined) cartItem.variantId = variantId;
    formData.set("cartItems", JSON.stringify({
      line_1: cartItem,
    }));

    const result = await processOrder(formData);

    expect(result).toEqual({
      success: false,
      error: { message: 'Cart item "Simple Product" has an invalid or missing saved variant.' },
    });
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("validates discounts against the server-validated cart snapshot", async () => {
    const formData = buildCodFormData();
    formData.set("discountCodeHidden", JSON.stringify({ code: "SAVE10" }));
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: true,
        issues: [],
        items: [
          {
            index: 0,
            cartKey: "line_1",
            productId: "product-1",
            variantId: "variant_1",
            quantity: 1,
            unitPrice: 90,
            productName: "Product 1",
            variantLabel: null,
            freeDelivery: true,
            availableQuantity: 5,
          },
        ],
        subtotal: 90,
        hasFreeDeliveryProduct: true,
        delivery: {
          shippingCharge: 0,
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: null,
        },
      },
    });
    mocks.validateDiscount.mockResolvedValueOnce({
      valid: true,
      discountAmount: 9,
      discount: { code: "SAVE10" },
    });

    const result = await processOrder(formData);

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.validateDiscount).toHaveBeenCalledWith(
      "SAVE10",
      90,
      [
        expect.objectContaining({
          id: "product-1",
          variantId: "variant_1",
          price: 90,
          quantity: 1,
          freeDelivery: true,
        }),
      ],
      0,
      "+8801712345678",
    );
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        discountAmount: 9,
        discountCode: "SAVE10",
        items: [expect.objectContaining({ price: 90 })],
        shippingCharge: 0,
      }),
      { customerSessionToken: undefined },
    );
  });

  it("blocks COD order creation when cart validation returns item issues", async () => {
    const issue = {
      index: 0,
      cartKey: "line_1",
      productId: "product-1",
      variantId: null,
      code: "PRODUCT_UNAVAILABLE" as const,
      action: "remove" as const,
      message: "Product 1 is no longer available.",
      productName: "Product 1",
      variantLabel: null,
      requestedQuantity: 1,
    };
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [issue],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const result = await processOrder(buildCodFormData());

    expect(result).toEqual({
      success: false,
      error: { message: "Product 1 is no longer available." },
      details: { itemIssues: [issue] },
    });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("returns all cart validation item issues with original cart keys for COD repair", async () => {
    const formData = buildCodFormData();
    formData.set("cartItems", JSON.stringify({
      line_a: {
        id: "product-a",
        slug: "product-a",
        name: "Product A",
        price: 100,
        quantity: 2,
        variantId: "variant_a",
      },
      line_b: {
        id: "product-b",
        slug: "product-b",
        name: "Product B",
        price: 200,
        quantity: 1,
        variantId: "variant_b",
      },
    }));
    const issues = [
      {
        index: 0,
        cartKey: "line_a",
        productId: "product-a",
        variantId: "variant_a",
        code: "QUANTITY_UNAVAILABLE" as const,
        action: "reduce_quantity" as const,
        message: "Only 1 Product A left.",
        productName: "Product A",
        variantLabel: null,
        requestedQuantity: 2,
        availableQuantity: 1,
      },
      {
        index: 1,
        cartKey: "line_b",
        productId: "product-b",
        variantId: "variant_b",
        code: "PRODUCT_UNAVAILABLE" as const,
        action: "remove" as const,
        message: "Product B is no longer available.",
        productName: "Product B",
        variantLabel: null,
        requestedQuantity: 1,
      },
    ];
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues,
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const result = await processOrder(formData);

    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({ cartKey: "line_a", productId: "product-a" }),
        expect.objectContaining({ cartKey: "line_b", productId: "product-b" }),
      ],
      expect.any(Object),
    );
    expect(result).toEqual({
      success: false,
      error: { message: "Only 1 Product A left." },
      details: { itemIssues: issues },
    });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("preserves late create-order item issues for COD cart repair", async () => {
    const issue = {
      index: 0,
      cartKey: "line_1",
      productId: "product-1",
      variantId: "variant_1",
      code: "PRICE_CHANGED" as const,
      action: "refresh_item" as const,
      message: "Product 1 price changed.",
      productName: "Product 1",
      variantLabel: null,
      requestedQuantity: 1,
      submittedPrice: 100,
      currentPrice: 120,
    };
    mocks.createOrder.mockResolvedValueOnce({
      success: false,
      error: "Some items in your cart need attention.",
      details: { itemIssues: [issue] },
      status: 400,
    });

    const result = await processOrder(buildCodFormData());

    expect(result).toEqual({
      success: false,
      error: "Some items in your cart need attention.",
      details: { itemIssues: [issue] },
      status: 400,
    });
  });
});
