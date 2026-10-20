// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("./transport", () => ({
  apiFetch: mocks.apiFetch,
}));

import { createOrder, getOrderReceipt } from "./orders";

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

function buildOrderPayload() {
  return {
    checkoutRequestId: "checkout_req_123456",
    expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
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

describe("storefront orders API client", () => {
  it("creates public checkout orders without minting a service JWT", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/orders",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Customer-Session": "customer_session_1",
        }),
      }),
      { retries: 0, timeout: 15000, auth: false },
    );
  });

  it("fetches private receipts with header proof instead of URL proof", async () => {
    const buyerUi = [{
      appId: "example.loyalty", releaseId: "release_1", target: "order.confirmation",
      ui: { type: "text", text: "You earned 20 points" }, attributes: [], values: {},
    }];
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
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
          supportRequestIntro: "Send a request and the store will review it.",
          buyerUi,
        },
      },
    }), { status: 200 }));

    const receipt = await getOrderReceipt("order_1", "chk_secret");

    expect(receipt?.id).toBe("order_1");
    expect(receipt?.buyerUi).toEqual(buyerUi);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/orders/receipt/order_1",
      expect.objectContaining({
        cache: "no-store",
        headers: { "X-Receipt-Token": "chk_secret", "x-storefront-language": "en", "x-storefront-locale": "en-BD" },
      }),
      { retries: 2, timeout: 5000, auth: false },
    );
    expect(mocks.apiFetch.mock.calls[0]?.[0]).not.toContain("token=");
  });

  it("distinguishes expired receipt proof from a retryable outage", async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(getOrderReceipt("order_1", "chk_expired"))
      .rejects.toEqual(expect.objectContaining({
        name: "OrderReceiptAccessError",
        status: 404,
      }));
  });
});
