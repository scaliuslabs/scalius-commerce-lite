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

import { createOrder, getOrderReceipt } from "./orders";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
});

function buildOrderPayload() {
  return {
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
    paymentMethod: "cod" as const,
  };
}

function mockImmediatePollingTimers() {
  return vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

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

    const result = await createOrder(buildOrderPayload(), { customerSessionToken: "customer_session_1" });

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

  it("polls duplicate processing orders with a status token instead of receipt proof", async () => {
    const timers = mockImmediatePollingTimers();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          statusToken: "cst_poll_token",
          checkoutToken: "chk_must_not_be_polled",
          orderId: "order_processing",
          status: "processing",
        },
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: "completed",
          orderId: "order_processing",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          orderId: "order_processing",
          receiptToken: "chk_receipt_ready",
          totalAmount: 125,
          paymentMethod: "cod",
        },
      }), { status: 201 }));

    try {
      const result = await createOrder(buildOrderPayload());

      expect(result).toMatchObject({
        success: true,
        orderId: "order_processing",
        receiptToken: "chk_receipt_ready",
        statusToken: "cst_poll_token",
      });
      expect(result.receiptToken).not.toBe(result.statusToken);
      expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).toBe("https://api.example.test/api/v1/orders/status/cst_poll_token");
      expect(mocks.fetchWithRetry.mock.calls[2]?.[0]).toBe("https://api.example.test/api/v1/orders");
      expect(JSON.stringify(mocks.fetchWithRetry.mock.calls.map((call) => call[0]))).not.toContain("/orders/status/chk_");
      expect(JSON.stringify(mocks.fetchWithRetry.mock.calls.map((call) => call[0]))).not.toContain("chk_must_not_be_polled");
    } finally {
      timers.mockRestore();
    }
  });

  it("replays a completed duplicate privately instead of expecting receipt proof from status", async () => {
    const timers = mockImmediatePollingTimers();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          statusToken: "cst_poll_without_receipt",
          orderId: "order_processing",
          status: "processing",
        },
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: "completed",
          orderId: "order_processing",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          orderId: "order_processing",
          receiptToken: "chk_replayed_receipt",
          totalAmount: 125,
          paymentMethod: "cod",
        },
      }), { status: 201 }));

    try {
      const result = await createOrder(buildOrderPayload());

      expect(result).toMatchObject({
        success: true,
        orderId: "order_processing",
        receiptToken: "chk_replayed_receipt",
        statusToken: "cst_poll_without_receipt",
      });
      expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).toBe("https://api.example.test/api/v1/orders/status/cst_poll_without_receipt");
      expect(mocks.fetchWithRetry.mock.calls[2]?.[0]).toBe("https://api.example.test/api/v1/orders");
      expect(JSON.stringify(mocks.fetchWithRetry.mock.calls.map((call) => call[0]))).not.toContain("/orders/status/chk_");
    } finally {
      timers.mockRestore();
    }
  });

  it("does not use the status token as receipt proof when private replay lacks a receipt token", async () => {
    const timers = mockImmediatePollingTimers();
    mocks.fetchWithRetry
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          statusToken: "cst_poll_without_receipt",
          orderId: "order_processing",
          status: "processing",
        },
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: "completed",
          orderId: "order_processing",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          orderId: "order_processing",
        },
      }), { status: 200 }));

    try {
      const result = await createOrder(buildOrderPayload());

      expect(result).toMatchObject({
        success: false,
        error: "Order completed but receipt proof is unavailable. Please check your order history.",
      });
      expect(result.receiptToken).toBeUndefined();
      expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).toBe("https://api.example.test/api/v1/orders/status/cst_poll_without_receipt");
      expect(mocks.fetchWithRetry.mock.calls[2]?.[0]).toBe("https://api.example.test/api/v1/orders");
    } finally {
      timers.mockRestore();
    }
  });

  it("fetches private receipts with header proof instead of URL proof", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        order: {
          id: "order_1",
          customerName: "Receipt Customer",
          shippingAddress: "Dhaka",
          totalAmount: 125,
          shippingCharge: 0,
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
          balanceDue: 125,
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
          items: [],
          supportRequests: [],
          supportRequestActions: [],
        },
      },
    }), { status: 200 }));

    const receipt = await getOrderReceipt("order_1", "chk_secret");

    expect(receipt?.id).toBe("order_1");
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/orders/receipt/order_1",
      expect.objectContaining({
        cache: "no-store",
        headers: { "X-Receipt-Token": "chk_secret" },
      }),
      2,
      5000,
      false,
    );
    expect(mocks.fetchWithRetry.mock.calls[0]?.[0]).not.toContain("token=");
  });

  it("polls duplicate checkout status with non-bearer status token", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: "processing",
          statusToken: "cst_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          orderId: "order_1",
        },
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: "completed",
          orderId: "order_1",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          orderId: "order_1",
          receiptToken: "chk_private_receipt",
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
    });

    expect(result).toMatchObject({
      success: true,
      orderId: "order_1",
      receiptToken: "chk_private_receipt",
    });
    expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).toContain("/orders/status/cst_");
    expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).not.toContain("/orders/status/chk_");
    expect(mocks.fetchWithRetry.mock.calls[2]?.[0]).toBe("https://api.example.test/api/v1/orders");
  });
});
