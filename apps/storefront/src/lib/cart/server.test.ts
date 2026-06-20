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
  });

  it("forwards the authenticated customer session token to COD order creation", async () => {
    const result = await processOrder(buildCodFormData(), {
      customerSessionToken: "session_123",
    });

    expect(result).toMatchObject({ success: true, orderId: "order_1" });
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethod: "cod",
        customerPhone: "+8801712345678",
        shippingMethodId: "ship_1",
      }),
      { customerSessionToken: "session_123" },
    );
  });
});
