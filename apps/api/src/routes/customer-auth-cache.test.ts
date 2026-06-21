import { OpenAPIHono } from "@hono/zod-openapi";
import { splitSetCookieHeader } from "better-auth/cookies";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  deleteCustomerAuthOtpChallenge: vi.fn(),
  getCustomerBySession: vi.fn(),
  getCustomerOrders: vi.fn(),
  getCustomerOrderDetail: vi.fn(),
  resolveCustomerPaymentSessionRecovery: vi.fn(),
  getSessionCookie: vi.fn(),
  createStripePaymentSession: vi.fn(),
  createSSLCommerzPaymentSession: vi.fn(),
  createPolarPaymentSession: vi.fn(),
}));

vi.mock("@scalius/core/modules/customers/customer-auth.service", () => ({
  sendOtp: mocks.sendOtp,
  verifyOtp: mocks.verifyOtp,
  deleteCustomerAuthOtpChallenge: mocks.deleteCustomerAuthOtpChallenge,
  getCustomerBySession: mocks.getCustomerBySession,
  deleteCustomerSession: vi.fn(),
  updateCustomerProfile: vi.fn(),
  getSessionCookie: mocks.getSessionCookie,
  getCookieConfig: vi.fn(() => ({ sameSite: "Lax", domainAttr: "" })),
  buildSetCookieHeader: vi.fn(() => "cs_tok=session_1; Path=/; HttpOnly"),
  COOKIE_NAME: "cs_tok",
  SESSION_TTL_SECONDS: 2_592_000,
}));

vi.mock("@scalius/core/modules/customers/customers.service", () => ({
  getCustomerOrders: mocks.getCustomerOrders,
  getCustomerOrderDetail: mocks.getCustomerOrderDetail,
}));

vi.mock("./payment/payment-session-create", () => ({
  createStripePaymentSession: mocks.createStripePaymentSession,
  createSSLCommerzPaymentSession: mocks.createSSLCommerzPaymentSession,
  createPolarPaymentSession: mocks.createPolarPaymentSession,
  resolveCustomerPaymentSessionRecovery: mocks.resolveCustomerPaymentSessionRecovery,
}));

import { customerAuthRoutes } from "./customer-auth";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/customer-auth", customerAuthRoutes);
  return app;
}

describe("customer auth private cache policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionCookie.mockReturnValue("session_1");
    mocks.sendOtp.mockResolvedValue({
      success: true,
      message: "Verification code sent to your email",
    });
    mocks.verifyOtp.mockResolvedValue({
      success: true,
      customer: {
        email: "customer@example.com",
        name: "Customer",
        phone: "+8801712345678",
        customerId: "customer_1",
      },
      isNewUser: false,
      session: { token: "session_1" },
    });
    mocks.getCustomerBySession.mockResolvedValue({
      email: "customer@example.com",
      name: "Customer",
      phone: "+8801712345678",
      customerId: "customer_1",
    });
    mocks.getCustomerOrders.mockResolvedValue({
      orders: [
        {
          id: "order_1",
          status: "pending",
          totalAmount: 100,
          createdAt: "2026-06-18T00:00:00.000Z",
          latestShipment: {
            id: "shipment_1",
            providerType: "steadfast",
            providerName: "Steadfast",
            status: "in_transit",
            rawStatus: "In Transit",
            trackingId: "SF123",
            trackingUrl: "https://steadfast.com.bd/t/SF123",
            courierName: null,
            lastChecked: "2026-06-18T01:00:00.000Z",
            updatedAt: "2026-06-18T01:00:00.000Z",
            createdAt: "2026-06-18T00:30:00.000Z",
          },
        },
      ],
      customerProfile: {
        id: "customer_1",
        name: "Customer",
        email: "customer@example.com",
        phone: "+8801712345678",
      },
    });
    mocks.getCustomerOrderDetail.mockResolvedValue({
      order: {
        id: "order_1",
        invoiceNumber: 12,
        status: "shipped",
        totalAmount: 100,
        paidAmount: 100,
        balanceDue: 0,
        shippingCharge: 60,
        discountAmount: 0,
        paymentStatus: "paid",
        paymentMethod: "sslcommerz",
        fulfillmentStatus: "partial",
        expectedDelivery: "2026-06-22",
        shippingAddress: "Dhaka",
        city: "dhaka",
        zone: "mirpur",
        area: null,
        cityName: "Dhaka",
        zoneName: "Mirpur",
        areaName: null,
        notes: null,
        createdAt: "2026-06-18T00:00:00.000Z",
        updatedAt: "2026-06-18T01:00:00.000Z",
      },
      items: [
        {
          id: "item_1",
          productId: "product_1",
          variantId: null,
          quantity: 2,
          price: 50,
          unitPrice: 50,
          lineTotal: 100,
          productName: "Product",
          productSlug: "product",
          productImage: null,
          variantSize: null,
          variantColor: null,
          fulfillmentStatus: "shipped",
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      ],
      shipments: [
        {
          id: "shipment_1",
          providerType: "steadfast",
          providerName: "Steadfast",
          status: "in_transit",
          rawStatus: "In Transit",
          trackingId: "SF123",
          trackingUrl: "https://steadfast.com.bd/t/SF123",
          courierName: null,
          note: null,
          shipmentAmount: null,
          isFinalShipment: false,
          lastChecked: "2026-06-18T01:00:00.000Z",
          updatedAt: "2026-06-18T01:00:00.000Z",
          createdAt: "2026-06-18T00:30:00.000Z",
        },
      ],
      payments: [
        {
          id: "payment_1",
          amount: 100,
          currency: "BDT",
          paymentMethod: "sslcommerz",
          paymentType: "full",
          status: "confirmed",
          codReceiptUrl: null,
          createdAt: "2026-06-18T00:10:00.000Z",
          updatedAt: "2026-06-18T00:12:00.000Z",
        },
      ],
      paymentPlan: null,
      cod: null,
      notifications: [
        {
          id: "receipt_1",
          notificationType: "order_shipped",
          channel: "sms",
          status: "accepted",
          provider: "gennet",
          providerStatus: "accepted",
          acceptedAt: "2026-06-18T01:05:00.000Z",
          deliveredAt: null,
          failedAt: null,
          skippedAt: null,
          updatedAt: "2026-06-18T01:05:00.000Z",
          createdAt: "2026-06-18T01:04:00.000Z",
        },
      ],
      timeline: [
        {
          id: "order-created:order_1",
          type: "order",
          status: "shipped",
          label: "Order placed",
          happenedAt: "2026-06-18T00:00:00.000Z",
        },
        {
          id: "shipment:shipment_1",
          type: "shipment",
          status: "in_transit",
          label: "Shipment In Transit",
          happenedAt: "2026-06-18T01:00:00.000Z",
        },
      ],
    });
    mocks.resolveCustomerPaymentSessionRecovery.mockResolvedValue({
      eligible: true,
      gateway: "sslcommerz",
      paymentType: "balance",
      amountDue: 900,
      label: "Pay balance",
      reason: null,
      requiresCardForm: false,
      hostedRedirect: true,
    });
    mocks.createSSLCommerzPaymentSession.mockResolvedValue({
      gateway: "sslcommerz",
      paymentType: "balance",
      amount: 900,
      currency: "BDT",
      hosted: {
        gatewayUrl: "https://ssl.example.test/pay",
        sessionKey: "ssl_session_1",
      },
    });
    mocks.createStripePaymentSession.mockResolvedValue({
      gateway: "stripe",
      paymentType: "full",
      amount: 1200,
      currency: "bdt",
      stripe: {
        clientSecret: "pi_secret_1",
        paymentIntentId: "pi_1",
        publishableKey: "pk_test",
        amount: 1200,
        currency: "bdt",
      },
    });
    mocks.createPolarPaymentSession.mockResolvedValue({
      gateway: "polar",
      paymentType: "full",
      amount: 1200,
      currency: "bdt",
      hosted: {
        gatewayUrl: "https://polar.example.test/pay",
        checkoutId: "polar_checkout_1",
      },
    });
  });

  it("marks customer session reads as private no-store", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/me",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
  });

  it("passes customer auth intent, channel, and secondary contact fields to OTP service", async () => {
    const app = createTestApp();
    const env = {
      CACHE: {},
      AUTH_OTP_QUEUE: { send: vi.fn(async () => undefined) },
    } as never;

    const response = await app.request(
      "/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "sign_up",
          method: "email",
          channel: "email",
          identifier: "buyer@example.com",
          phone: "+8801712345678",
          email: "backup@example.com",
        }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.sendOtp).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({
        intent: "sign_up",
        method: "email",
        channel: "email",
        identifier: "buyer@example.com",
        phone: "+8801712345678",
        email: "backup@example.com",
      }),
    );
  });

  it("uses CF-Connecting-IP for customer OTP rate-limit identity over spoofed XFF", async () => {
    const app = createTestApp();

    const response = await app.request(
      "https://api.scalius.com/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
          "X-Forwarded-For": "198.51.100.99",
        },
        body: JSON.stringify({
          method: "email",
          channel: "email",
          identifier: "buyer@example.com",
        }),
      },
      {
        CACHE: {},
        PUBLIC_API_BASE_URL: "https://api.scalius.com",
        AUTH_OTP_QUEUE: { send: vi.fn(async () => undefined) },
      } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.sendOtp).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({
        ip: "203.0.113.10",
      }),
    );
  });

  it("ignores spoofable XFF for customer OTP identity outside loopback runtimes", async () => {
    const app = createTestApp();

    const response = await app.request(
      "https://api.scalius.com/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.99",
        },
        body: JSON.stringify({
          method: "email",
          channel: "email",
          identifier: "buyer@example.com",
        }),
      },
      {
        CACHE: {},
        PUBLIC_API_BASE_URL: "https://api.scalius.com",
        AUTH_OTP_QUEUE: { send: vi.fn(async () => undefined) },
      } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.sendOtp).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({
        ip: "unknown",
      }),
    );
  });

  it("allows parsed XFF for customer OTP identity in loopback local development", async () => {
    const app = createTestApp();

    const response = await app.request(
      "http://localhost:8787/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.77, 198.51.100.88",
        },
        body: JSON.stringify({
          method: "email",
          channel: "email",
          identifier: "buyer@example.com",
        }),
      },
      {
        CACHE: {},
        PUBLIC_API_BASE_URL: "http://localhost:8787",
        AUTH_OTP_QUEUE: { send: vi.fn(async () => undefined) },
      } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.sendOtp).toHaveBeenCalledWith(
      expect.anything(),
      {},
      expect.objectContaining({
        ip: "198.51.100.77",
      }),
    );
  });

  it("sets both session and readable auth mirror cookies after OTP verification", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/verify-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "sign_in",
          method: "email",
          channel: "email",
          identifier: "customer@example.com",
          code: "123456",
        }),
      },
      { CACHE: {} } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const cookies = splitSetCookieHeader(response.headers.get("set-cookie") ?? "");
    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^cs_tok=session_1; Path=\/; HttpOnly/),
      "cs_auth=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure",
    ]));
  });

  it("marks customer order-history reads as private no-store", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
  });

  it("returns customer shipment tracking summary with order history", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        orders: [
          {
            id: "order_1",
            latestShipment: {
              id: "shipment_1",
              providerType: "steadfast",
              providerName: "Steadfast",
              status: "in_transit",
              trackingId: "SF123",
              trackingUrl: "https://steadfast.com.bd/t/SF123",
            },
          },
        ],
      },
    });
  });

  it("marks customer order detail reads as private no-store and scopes by customer id", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(mocks.getCustomerOrderDetail).toHaveBeenCalledWith(
      expect.anything(),
      "customer_1",
      "order_1",
    );
    expect(mocks.resolveCustomerPaymentSessionRecovery).toHaveBeenCalledWith(
      expect.anything(),
      {
        orderId: "order_1",
        expectedCustomerId: "customer_1",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        order: {
          id: "order_1",
          invoiceNumber: 12,
          paymentStatus: "paid",
        },
        shipments: [
          {
            id: "shipment_1",
            trackingId: "SF123",
          },
        ],
        payments: [
          {
            id: "payment_1",
            status: "confirmed",
          },
        ],
        notifications: [
          {
            channel: "sms",
            status: "accepted",
          },
        ],
        timeline: expect.arrayContaining([
          expect.objectContaining({
            type: "order",
            label: "Order placed",
          }),
        ]),
        paymentRecovery: {
          eligible: true,
          paymentType: "balance",
          amountDue: 900,
        },
      },
    });
  });

  it("rejects customer order detail reads when the session has no customer id", async () => {
    const app = createTestApp();
    mocks.getCustomerBySession.mockResolvedValueOnce({
      email: "customer@example.com",
      name: "Customer",
      phone: "+8801712345678",
      customerId: null,
    });

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1",
      { headers: { Cookie: "cs_tok=session_1" } },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.getCustomerOrderDetail).not.toHaveBeenCalled();
  });

  it("creates customer-owned hosted payment sessions without exposing receipt tokens", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1/payment-session",
      {
        method: "POST",
        headers: { Cookie: "cs_tok=session_1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { CACHE: {} } as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    expect(mocks.resolveCustomerPaymentSessionRecovery).toHaveBeenCalledWith(
      expect.anything(),
      {
        orderId: "order_1",
        expectedCustomerId: "customer_1",
      },
    );
    expect(mocks.createSSLCommerzPaymentSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: "order_1",
        paymentType: "balance",
        proof: { kind: "customer_account", customerId: "customer_1" },
        returnTarget: { kind: "customer_account" },
        expectedCustomerId: "customer_1",
      }),
    );
    const text = await response.text();
    expect(text).toContain("https://ssl.example.test/pay");
    expect(text).not.toContain("receiptToken");
    expect(text).not.toContain("chk_");
  });

  it("rejects account payment session requests without customer ownership", async () => {
    const app = createTestApp();
    mocks.getCustomerBySession.mockResolvedValueOnce({
      email: "customer@example.com",
      name: "Customer",
      phone: "+8801712345678",
      customerId: null,
    });

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1/payment-session",
      {
        method: "POST",
        headers: { Cookie: "cs_tok=session_1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveCustomerPaymentSessionRecovery).not.toHaveBeenCalled();
    expect(mocks.createSSLCommerzPaymentSession).not.toHaveBeenCalled();
  });

  it("rejects body attempts to override account payment session authority", async () => {
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1/payment-session",
      {
        method: "POST",
        headers: { Cookie: "cs_tok=session_1", "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: "stripe",
          amount: 1,
          receiptToken: "chk_attacker",
        }),
      },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.createSSLCommerzPaymentSession).not.toHaveBeenCalled();
  });

  it("rejects customer payment sessions when recovery state is not eligible", async () => {
    const app = createTestApp();
    mocks.resolveCustomerPaymentSessionRecovery.mockResolvedValueOnce({
      eligible: false,
      gateway: null,
      paymentType: null,
      amountDue: 0,
      label: null,
      reason: "This order is not waiting for an online payment.",
      blockType: "validation",
      requiresCardForm: false,
      hostedRedirect: false,
    });

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1/payment-session",
      {
        method: "POST",
        headers: { Cookie: "cs_tok=session_1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.createSSLCommerzPaymentSession).not.toHaveBeenCalled();
  });

  it("returns service unavailable when the account recovery gateway is not ready", async () => {
    const app = createTestApp();
    mocks.resolveCustomerPaymentSessionRecovery.mockResolvedValueOnce({
      eligible: false,
      gateway: "sslcommerz",
      paymentType: null,
      amountDue: 0,
      label: null,
      reason: "SSLCommerz gateway is not enabled for checkout.",
      blockType: "unavailable",
      requiresCardForm: false,
      hostedRedirect: false,
    });

    const response = await app.request(
      "/api/v1/customer-auth/orders/order_1/payment-session",
      {
        method: "POST",
        headers: { Cookie: "cs_tok=session_1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { CACHE: {} } as never,
    );

    expect(response.status).toBe(503);
    expect(mocks.createSSLCommerzPaymentSession).not.toHaveBeenCalled();
  });

  it("clears OTP challenge state when queue handoff fails", async () => {
    const app = createTestApp();
    const queueSend = vi.fn().mockRejectedValue(new Error("queue down"));
    mocks.deleteCustomerAuthOtpChallenge.mockResolvedValue(undefined);
    mocks.sendOtp.mockResolvedValue({
      success: true,
      message: "Verification code sent to your email",
      otpStorageKey: "cust_otp:email:buyer@example.com",
      deliveryKey: "otp_delivery_1",
      queuePayload: {
        type: "auth.send_otp",
        deliveryKey: "otp_delivery_1",
        purpose: "customer_login",
        otpExpiresAt: 4_102_444_800,
        method: "email",
        allowedMethod: "email",
        identifier: "buyer@example.com",
        code: "123456",
        name: "Buyer",
      },
    });

    const response = await app.request(
      "/api/v1/customer-auth/send-otp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "email",
          identifier: "Buyer@Example.com",
          name: "Buyer",
        }),
      },
      {
        CACHE: {},
        AUTH_OTP_QUEUE: { send: queueSend },
      } as never,
    );

    expect(response.status).toBe(503);
    expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_1",
    }));
    expect(mocks.deleteCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      {},
      {
        otpKey: "cust_otp:email:buyer@example.com",
        deliveryKey: "otp_delivery_1",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
      },
    });
  });
});
