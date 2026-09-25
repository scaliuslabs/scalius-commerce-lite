import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getCities: vi.fn(),
  getZones: vi.fn(),
  getAreas: vi.fn(),
  getProductBySlug: vi.fn(),
  getShippingMethods: vi.fn(),
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
  formData.set("expectedQuoteFingerprint", "taxq_abcdefghijklmnopqrstuv");
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
        expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
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

  it("hands the applied codes to the authoritative order commit without touching the notes", async () => {
    const formData = buildCodFormData();
    formData.set("discountCodes", JSON.stringify(["save10", "SHIPFREE"]));
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
    const result = await processOrder(formData);

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCodes: ["SAVE10", "SHIPFREE"],
        notes: null,
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

/**
 * The no-JS / pre-hydration COD form (Wave A §2.7, §8.2): the same three
 * paths as the browser checkout. Phone is required on every path, the address
 * only when something ships, and buyer inputs travel in the body.
 */
describe("cart server order processing: delivery, pickup and nothing to deliver", () => {
  const validatedLine = {
    index: 0,
    cartKey: "line_1",
    productId: "product-1",
    variantId: "variant_1",
    quantity: 1,
    unitPrice: 300,
    productName: "Engraved pen",
    variantLabel: null,
    freeDelivery: false,
    availableQuantity: 5,
    propertiesHash: "0123456789abcdef",
    properties: [{ key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", price: 200, priceMinor: 20_000 }],
  };

  function formWith(values: Record<string, string>, line: Record<string, unknown> = {}): FormData {
    const formData = buildCodFormData();
    for (const [key, value] of Object.entries(values)) {
      if (value === "") formData.delete(key);
      else formData.set(key, value);
    }
    formData.set("cartItems", JSON.stringify({
      line_1: {
        id: "product-1",
        name: "Engraved pen",
        price: 300,
        quantity: 1,
        variantId: "variant_1",
        properties: [{ key: "engraving", value: "Anika", label: "Engraving", displayValue: "Anika", priceMinor: 20_000 }],
        propertiesHash: "0123456789abcdef",
        ...line,
      },
    }));
    return formData;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOrder.mockResolvedValue({ success: true, orderId: "order_1", receiptToken: "receipt_1" });
  });

  it("sends a pickup order with the pickup rate only, and no address even when one was typed", async () => {
    mocks.validateCartItems.mockResolvedValue({
      success: true,
      data: {
        valid: true, issues: [], items: [validatedLine], subtotal: 300, hasFreeDeliveryProduct: false,
        requiresDeliveryMethod: true, deliveryMethodKind: "pickup", requiresShipping: false,
        allowedPaymentMethods: ["cod"],
        delivery: {
          kind: "pickup", shippingCharge: 0, cityName: null, zoneName: null, areaName: null,
          shippingMethod: { id: "pickup_1", name: "Shop pickup", description: null, baseAmountMinor: 0, feeWaived: false },
          pickup: { address: "Shop 12, Dhanmondi", hours: "10am–8pm" },
        },
      },
    });

    const result = await processOrder(formWith({ deliveryMode: "pickup", shippingLocation: "pickup_1" }));

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [expect.objectContaining({ properties: [{ key: "engraving", value: "Anika" }] })],
      { shippingMethodId: "pickup_1" },
    );
    const payload = mocks.createOrder.mock.calls[0]![0];
    expect(payload).toMatchObject({
      customerPhone: "+8801712345678",
      shippingAddress: null,
      city: null,
      zone: null,
      area: null,
      shippingMethodId: "pickup_1",
      shippingCharge: 0,
      items: [expect.objectContaining({ price: 300, properties: [{ key: "engraving", value: "Anika" }] })],
    });
    // Only identity goes to the order: labels and prices come from the server.
    expect(JSON.stringify(payload.items)).not.toContain("displayValue");
  });

  it("needs only name and phone when nothing in the cart is physical", async () => {
    mocks.validateCartItems.mockResolvedValue({
      success: true,
      data: {
        valid: true, issues: [], items: [{ ...validatedLine, fulfillmentKind: "service" }], subtotal: 300,
        hasFreeDeliveryProduct: false, requiresDeliveryMethod: false, deliveryMethodKind: null,
        requiresShipping: false, allowedPaymentMethods: ["cod"],
      },
    });

    const result = await processOrder(formWith({
      shippingAddress: "", city: "", zone: "", shippingLocation: "",
    }));

    expect(result).toMatchObject({ success: true });
    expect(mocks.validateCartItems).toHaveBeenCalledWith(expect.any(Array), {});
    expect(mocks.createOrder.mock.calls[0]![0]).toMatchObject({
      shippingAddress: null,
      city: null,
      zone: null,
      shippingMethodId: null,
      shippingCharge: 0,
    });
  });

  it("still requires the phone when nothing is delivered", async () => {
    const result = await processOrder(formWith({ customerPhone: "", shippingAddress: "", city: "", zone: "", shippingLocation: "" }));
    expect(result).toMatchObject({ success: false });
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("requires the address for a delivery rate", async () => {
    mocks.validateCartItems.mockResolvedValue({
      success: true,
      data: {
        valid: true, issues: [], items: [validatedLine], subtotal: 300, hasFreeDeliveryProduct: false,
        requiresDeliveryMethod: true, deliveryMethodKind: null, requiresShipping: false,
        allowedPaymentMethods: ["cod"],
      },
    });

    const result = await processOrder(formWith({ shippingAddress: "" }));

    expect(result).toMatchObject({
      success: false,
      error: { message: "Please fill in all required fields and add items to your cart." },
    });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("refuses cash on delivery for a cart the store can't take cash for", async () => {
    mocks.validateCartItems.mockResolvedValue({
      success: true,
      data: {
        valid: true, issues: [], items: [{ ...validatedLine, fulfillmentKind: "digital" }], subtotal: 300,
        hasFreeDeliveryProduct: false, requiresDeliveryMethod: false, deliveryMethodKind: null,
        requiresShipping: false, allowedPaymentMethods: ["stripe"],
      },
    });

    const result = await processOrder(formWith({ shippingAddress: "", city: "", zone: "", shippingLocation: "" }));

    expect(result).toMatchObject({ success: false });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("refuses malformed buyer inputs before calling the store", async () => {
    const result = await processOrder(formWith({}, { properties: [{ key: "Bad Key", value: "x" }] }));
    expect(result).toMatchObject({ success: false });
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });
});
