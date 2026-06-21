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
            cartKey: "cod:product-1:variant_1:0",
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
          cartKey: "cod:product-1:variant_1:0",
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

  it("resolves legacy simple-product cart lines through cart validation before COD order creation", async () => {
    const formData = buildCodFormData();
    formData.set("cartItems", JSON.stringify({
      line_1: {
        id: "simple_product",
        slug: "simple-product",
        name: "Simple Product",
        price: 150,
        quantity: 2,
        variantId: "default",
      },
    }));
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: true,
        issues: [],
        items: [
          {
            index: 0,
            cartKey: "cod:simple_product:default:0",
            productId: "simple_product",
            variantId: "var_default_simple",
            quantity: 2,
            unitPrice: 150,
            productName: "Simple Product",
            variantLabel: null,
            freeDelivery: false,
            availableQuantity: null,
          },
        ],
        subtotal: 300,
        hasFreeDeliveryProduct: false,
        delivery: {
          shippingCharge: 60,
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: null,
        },
      },
    });

    const result = await processOrder(formData);

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          productId: "simple_product",
          variantId: null,
          price: 150,
        }),
      ],
      expect.any(Object),
    );
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            productId: "simple_product",
            variantId: "var_default_simple",
            quantity: 2,
            price: 150,
          }),
        ],
      }),
      { customerSessionToken: undefined },
    );
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
            cartKey: "cod:product-1:variant_1:0",
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
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [
          {
            index: 0,
            productId: "product-1",
            variantId: null,
            code: "PRODUCT_UNAVAILABLE",
            action: "remove",
            message: "Product 1 is no longer available.",
            productName: "Product 1",
            variantLabel: null,
            requestedQuantity: 1,
          },
        ],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const result = await processOrder(buildCodFormData());

    expect(result).toEqual({
      success: false,
      error: { message: "Product 1 is no longer available." },
    });
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
});
