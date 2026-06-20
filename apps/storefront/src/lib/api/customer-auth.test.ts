import { afterEach, describe, expect, it, vi } from "vitest";

import { createCustomerOrderPaymentSession } from "./customer-auth";

describe("customer auth API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates customer-owned payment sessions through the same-origin proxy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        gateway: "sslcommerz",
        paymentType: "balance",
        amount: 900,
        currency: "BDT",
        hosted: {
          gatewayUrl: "https://ssl.example.test/pay",
          sessionKey: "ssl_session_1",
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCustomerOrderPaymentSession("order_1");

    expect(result).toMatchObject({
      success: true,
      session: {
        gateway: "sslcommerz",
        paymentType: "balance",
        hosted: { gatewayUrl: "https://ssl.example.test/pay" },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/customer-auth/orders/order_1/payment-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body: "{}",
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init)).not.toContain("receipt");
    expect(JSON.stringify(init)).not.toContain("token");
  });

  it("extracts customer payment-session API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "Gateway unavailable" },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(createCustomerOrderPaymentSession("order_1")).resolves.toEqual({
      success: false,
      error: "Gateway unavailable",
      status: 503,
    });
  });

  it("rejects missing order ids before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCustomerOrderPaymentSession("")).resolves.toMatchObject({
      success: false,
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
