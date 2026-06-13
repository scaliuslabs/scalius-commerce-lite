import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  initSSLCommerzSession: vi.fn(),
  createPolarCheckout: vi.fn(),
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  getCurrencyConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
}));

vi.mock("@scalius/core/modules/payments/sslcommerz", () => ({
  initSSLCommerzSession: mocks.initSSLCommerzSession,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  createPolarCheckout: mocks.createPolarCheckout,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

import { polarPaymentRoutes } from "./polar-routes";
import { sslcommerzPaymentRoutes } from "./sslcommerz-routes";
import { stripePaymentRoutes } from "./stripe-routes";

const orderRow = {
  id: "order_1",
  totalAmount: 125,
  customerName: "Payment Customer",
  customerPhone: "+8801712345678",
  customerEmail: "buyer@example.com",
  shippingAddress: "1 Payment Street",
  cityName: "Dhaka",
  status: "pending",
  paymentMethod: "stripe",
  paymentStatus: "unpaid",
  paidAmount: 0,
  balanceDue: 125,
};

type TokenMode = "valid" | "wrong" | "missing";

function createDbMock(paymentMethod = "stripe") {
  const currentOrder = { ...orderRow, paymentMethod };
  const updateQuery = {
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  };
  const insertQuery = {
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(async () => undefined),
      onConflictDoUpdate: vi.fn(async () => undefined),
    })),
  };
  return {
    select: vi.fn(() => {
      const query = {
        from: () => query,
        where: () => query,
        get: vi.fn(async () => currentOrder),
      };
      return query;
    }),
    update: vi.fn(() => updateQuery),
    insert: vi.fn(() => insertQuery),
  };
}

function createKvMock(mode: TokenMode) {
  return {
    get: vi.fn(async (key: string) => {
      if (mode === "missing") return null;
      if (key !== "order_receipt:chk_valid") return null;
      return JSON.stringify({
        orderId: mode === "valid" ? "order_1" : "other_order",
      });
    }),
  };
}

function createTestApp(mode: TokenMode = "valid", paymentMethod = "stripe") {
  const db = createDbMock(paymentMethod);
  const kv = createKvMock(mode);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/payment/stripe", stripePaymentRoutes);
  app.route("/payment/sslcommerz", sslcommerzPaymentRoutes);
  app.route("/payment/polar", polarPaymentRoutes);

  return { app, db, kv };
}

function envFor(kv: ReturnType<typeof createKvMock>) {
  return {
    CACHE: kv,
    PUBLIC_API_BASE_URL: "https://api.example.test",
    STOREFRONT_URL: "https://shop.example.test",
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", usdExchangeRate: 110 });
  mocks.getStripeSettings.mockResolvedValue({
    enabled: true,
    secretKey: "sk_test",
    publishableKey: "pk_test",
  });
  mocks.createPaymentIntent.mockResolvedValue({
    success: true,
    clientSecret: "secret_1",
    paymentIntentId: "pi_1",
  });
  mocks.getSSLCommerzSettings.mockResolvedValue({
    enabled: true,
    storeId: "store",
    storePassword: "password",
    sandbox: true,
  });
  mocks.initSSLCommerzSession.mockResolvedValue({
    success: true,
    gatewayUrl: "https://ssl.example.test/pay",
    sessionKey: "ssl_session_1",
  });
  mocks.getPolarSettings.mockResolvedValue({
    enabled: true,
    accessToken: "polar_token",
    productId: "polar_product",
    sandbox: true,
  });
  mocks.createPolarCheckout.mockResolvedValue({
    success: true,
    checkoutUrl: "https://polar.example.test/pay",
    checkoutId: "polar_checkout_1",
  });
});

describe("payment session receipt-token proof", () => {
  it("rejects Stripe intent creation before gateway calls when the receipt token is missing", async () => {
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(kv.get).not.toHaveBeenCalled();
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects SSLCommerz session creation when the token belongs to another order", async () => {
    const { app, kv } = createTestApp("wrong", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(404);
    expect(kv.get).toHaveBeenCalledWith("order_receipt:chk_valid");
    expect(mocks.getSSLCommerzSettings).not.toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).not.toHaveBeenCalled();
  });

  it("uses trusted API config for SSLCommerz callbacks instead of caller baseUrl", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          baseUrl: "https://attacker.example",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledWith(
      "store",
      "password",
      true,
      expect.objectContaining({
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?receipt_token=chk_valid",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel",
        ipnUrl: "https://api.example.test/api/v1/webhooks/sslcommerz",
      }),
    );
  });

  it("uses trusted API config for Polar redirect URLs instead of caller URLs", async () => {
    const { app, kv } = createTestApp("valid", "polar");

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          successUrl: "https://attacker.example/success",
          cancelUrl: "https://attacker.example/cancel",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&receipt_token=chk_valid",
        cancelUrl: "https://api.example.test/api/v1/payment/polar/cancel?order_id=order_1",
      }),
    );
  });
});
