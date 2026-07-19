// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

import { GET } from "../../../../pages/api/order-receipt/status";
import { getOrderReceiptCookieName } from "../../../order-receipt-cookie";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
});

function request(orderId = "ord_1", cookie = "receipt_1") {
  return {
    request: new Request(
      `https://storefront.example.test/api/order-receipt/status?orderId=${encodeURIComponent(orderId)}`,
      {
        headers: cookie
          ? { Cookie: `${getOrderReceiptCookieName(orderId)}=${cookie}` }
          : undefined,
      },
    ),
    url: new URL(
      `https://storefront.example.test/api/order-receipt/status?orderId=${encodeURIComponent(orderId)}`,
    ),
  } as never;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      order: {
        id: "ord_1",
        status: "incomplete",
        paymentMethod: "sslcommerz",
        paymentStatus: "unpaid",
        paidAmount: 0,
        updatedAt: "2026-07-19T00:00:00.000Z",
        ...overrides,
      },
    },
  };
}

describe("receipt payment status proxy", () => {
  it("fails closed without a valid receipt reference and cookie", async () => {
    const invalid = await GET(request("bad/order", "receipt_1"));
    const missingProof = await GET(request("ord_1", ""));

    expect(invalid.status).toBe(400);
    expect(missingProof.status).toBe(404);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("returns only the derived pending state while payment is unconfirmed", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify(receipt()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await GET(request());
    const json = await response.json() as {
      success: boolean;
      data: { state: string; updatedAt: string };
    };
    const [, init, retries, timeout, requiresAuth] = mocks.fetchWithRetry.mock.calls[0]!;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(json).toEqual({
      success: true,
      data: {
        state: "payment_pending",
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(json)).not.toContain("receipt_1");
    expect(mocks.createApiUrl).toHaveBeenCalledWith("/orders/receipt/ord_1");
    expect(init).toMatchObject({
      headers: { "X-Receipt-Token": "receipt_1" },
      cache: "no-store",
    });
    expect(retries).toBe(1);
    expect(timeout).toBe(5000);
    expect(requiresAuth).toBe(false);
  });

  it("returns a settled state after authoritative payment confirmation", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify(receipt({
      status: "pending",
      paymentStatus: "paid",
      paidAmount: 9100,
    })), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await GET(request());
    const json = await response.json() as { data: { state: string } };

    expect(response.status).toBe(200);
    expect(json.data.state).toBe("order_placed");
  });

  it("does not expose backend receipt errors or malformed responses", async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));

    const missing = await GET(request());
    const malformed = await GET(request());

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      success: false,
      error: "Receipt status is temporarily unavailable.",
    });
    expect(malformed.status).toBe(502);
  });
});
