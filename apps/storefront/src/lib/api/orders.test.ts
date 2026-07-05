// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("./client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

import { createOrder } from "./orders";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
});

describe("storefront orders API client", () => {
  it("creates public checkout orders without minting a service JWT", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        id: "order_1",
        receiptToken: "chk_order_1",
        totalAmount: 125,
        paymentMethod: "cod",
      },
    }), { status: 201 }));

    const result = await createOrder({
      checkoutRequestId: "checkout_req_123456",
      customerName: "Test Customer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "123 Test Street",
      city: "city_1",
      zone: "zone_1",
      area: null,
      notes: null,
      items: [],
      shippingCharge: 0,
      discountAmount: null,
      paymentMethod: "cod",
    }, { customerSessionToken: "customer_session_1" });

    expect(result).toMatchObject({
      success: true,
      orderId: "order_1",
      receiptToken: "chk_order_1",
      totalAmount: 125,
      paymentMethod: "cod",
    });
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/orders",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Customer-Session": "customer_session_1",
        }),
      }),
      0,
      15000,
      false,
    );
  });
});
