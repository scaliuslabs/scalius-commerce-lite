import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCustomerOrderPaymentSession,
  getCustomerOrderDetail,
  getCustomerOrders,
  getCustomerSession,
} from "./customer-auth";

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

  it("keeps unauthenticated session reads distinct from temporary account-read failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { message: "Sign in required" },
    }), { status: 401, headers: { "Content-Type": "application/json" } })));

    await expect(getCustomerSession()).resolves.toEqual({
      authenticated: false,
      unavailable: false,
      status: 401,
      error: "Sign in required",
    });
  });

  it("marks retryable session read failures as unavailable instead of logged out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { message: "Database temporarily overloaded" },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(getCustomerSession()).resolves.toMatchObject({
      authenticated: false,
      unavailable: true,
      status: 503,
      error: "Database temporarily overloaded",
    });
  });

  it("fails closed when a successful session response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(getCustomerSession()).resolves.toMatchObject({
      authenticated: false,
      unavailable: true,
      status: 200,
      error: "Invalid account response. Please try again.",
    });
  });

  it("returns retryable order-history failures without pretending the list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { message: "Order service unavailable" },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(getCustomerOrders()).resolves.toEqual({
      success: false,
      orders: [],
      error: "Order service unavailable",
      status: 503,
      unavailable: true,
    });
  });

  it("marks order-detail network failures as retryable", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw abortError;
    }));

    await expect(getCustomerOrderDetail("order_1")).resolves.toMatchObject({
      success: false,
      error: "Account request timed out. Please try again.",
      status: 0,
      unavailable: true,
    });
  });
});
