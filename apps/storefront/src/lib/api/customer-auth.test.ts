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

  it("treats customer payment-session processing responses as retryable failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        status: "processing",
        retryable: true,
        retryAfterSeconds: 2,
        message: "Payment session creation is already processing. Please try again shortly.",
      },
    }), { status: 202, headers: { "Content-Type": "application/json" } })));

    await expect(createCustomerOrderPaymentSession("order_1")).resolves.toEqual({
      success: false,
      error: "Payment session creation is already processing. Please try again shortly.",
      status: 202,
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

  it("preserves delivery profile and completion flags from session reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        authenticated: true,
        customer: {
          customerId: "customer_1",
          email: "customer@example.com",
          name: "Customer",
          phone: "+8801712345678",
          address: "House 1",
          city: "city_dhaka",
          zone: "zone_mirpur",
          area: "area_1",
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: "Section 10",
          profileComplete: true,
          needsProfileCompletion: false,
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getCustomerSession()).resolves.toMatchObject({
      authenticated: true,
      customer: {
        customerId: "customer_1",
        address: "House 1",
        city: "city_dhaka",
        zone: "zone_mirpur",
        area: "area_1",
        cityName: "Dhaka",
        zoneName: "Mirpur",
        areaName: "Section 10",
        profileComplete: true,
        needsProfileCompletion: false,
      },
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

  it("preserves server-computed order-history balance and account summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        orders: [{
          id: "order_1",
          status: "partial",
          totalAmount: 100,
          paidAmount: 25,
          balanceDue: 75,
          shippingCharge: 60,
          discountAmount: 0,
          paymentStatus: "partial",
          paymentMethod: "sslcommerz",
          fulfillmentStatus: "pending",
          shippingAddress: "Dhaka",
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: null,
          notes: null,
          createdAt: "2026-06-24T00:00:00.000Z",
          latestShipment: null,
          items: [],
        }],
        summary: {
          totalOrders: 51,
          totalSpent: 12500,
          completedOrders: 49,
          pendingOrders: 1,
        },
        pagination: {
          limit: 50,
          returned: 50,
          hasMore: true,
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getCustomerOrders()).resolves.toMatchObject({
      success: true,
      orders: [{ id: "order_1", balanceDue: 75 }],
      summary: {
        totalOrders: 51,
        totalSpent: 12500,
      },
      pagination: {
        hasMore: true,
      },
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

  it("preserves buyer-safe refund progress in order detail responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        order: {
          id: "order_1",
          invoiceNumber: 1001,
          status: "processing",
          totalAmount: 100,
          paidAmount: 100,
          balanceDue: 0,
          shippingCharge: 0,
          discountAmount: null,
          paymentStatus: "paid",
          paymentMethod: "stripe",
          fulfillmentStatus: "pending",
          expectedDelivery: null,
          shippingAddress: "Dhaka",
          city: "city_dhaka",
          zone: "zone_mirpur",
          area: null,
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: null,
          notes: null,
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:00:00.000Z",
        },
        items: [],
        shipments: [],
        payments: [],
        refundAttempts: [{
          id: "rfa_1",
          orderId: "order_1",
          amount: 100,
          currency: "BDT",
          gateway: "stripe",
          status: "checking",
          providerStatus: null,
          active: true,
          severity: "warning",
          label: "Refund being verified",
          message: "The payment provider has not returned a final result yet. The merchant is verifying the refund.",
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:01:00.000Z",
          nextProbeAt: "2026-06-24T00:15:00.000Z",
          lastProbeAt: "2026-06-24T00:00:00.000Z",
          refundedAt: null,
          failedAt: null,
        }],
        activeRefundOperation: {
          active: true,
          status: "checking",
          severity: "warning",
          label: "Refund being verified",
          message: "The payment provider has not returned a final result yet. The merchant is verifying the refund.",
          amount: 100,
          currency: "BDT",
          gateway: "stripe",
          attemptCount: 1,
          nextProbeAt: "2026-06-24T00:15:00.000Z",
          lastProbeAt: "2026-06-24T00:00:00.000Z",
          providerStatus: null,
        },
        paymentPlan: null,
        cod: null,
        notifications: [],
        paymentRecovery: {
          eligible: false,
          gateway: null,
          paymentType: null,
          amountDue: 0,
          label: null,
          reason: "Refund in progress",
          requiresCardForm: false,
          hostedRedirect: false,
        },
        timeline: [{
          id: "refund:rfa_1",
          type: "refund",
          status: "checking",
          label: "Refund being verified",
          happenedAt: "2026-06-24T00:01:00.000Z",
          details: "The payment provider has not returned a final result yet. The merchant is verifying the refund.",
        }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await getCustomerOrderDetail("order_1");

    expect(result).toMatchObject({
      success: true,
      detail: {
        refundAttempts: [{
          status: "checking",
          providerStatus: null,
        }],
        activeRefundOperation: {
          status: "checking",
          providerStatus: null,
        },
        timeline: [{ type: "refund" }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider_unknown");
    expect(JSON.stringify(result)).not.toContain("reconcile_required");
    expect(JSON.stringify(result)).not.toContain("providerRefundId");
  });
});
