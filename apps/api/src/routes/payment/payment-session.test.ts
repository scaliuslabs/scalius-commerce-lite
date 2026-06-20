import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  initSSLCommerzSession: vi.fn(),
  createPolarCheckout: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  getCurrencyConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
}));

vi.mock("@scalius/core/modules/payments/sslcommerz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/sslcommerz")>()),
  initSSLCommerzSession: mocks.initSSLCommerzSession,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  createPolarCheckout: mocks.createPolarCheckout,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getActivePaymentMethods: mocks.getActivePaymentMethods,
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
import {
  OrderStatus,
  PaymentStatus,
  orders as ordersTable,
  paymentPlans as paymentPlansTable,
  siteSettings as siteSettingsTable,
} from "@scalius/database/schema";

const orderRow = {
  id: "order_1",
  totalAmount: 125,
  customerName: "Payment Customer",
  customerPhone: "+8801712345678",
  customerEmail: "buyer@example.com",
  shippingAddress: "1 Payment Street",
  cityName: "Dhaka",
  status: OrderStatus.PENDING as string,
  paymentMethod: "stripe",
  paymentStatus: PaymentStatus.UNPAID as string,
  paidAmount: 0,
  balanceDue: 125,
  deletedAt: null as Date | null,
  shipmentClaimId: null as string | null,
  shipmentClaimExpiresAt: null as Date | null,
};

type TokenMode = "valid" | "wrong" | "missing";

interface DbMockOptions {
  paymentMethod?: string;
  order?: Partial<typeof orderRow>;
  checkoutMode?: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled?: boolean;
  partialPaymentAmount?: number;
  paymentPlan?: { balanceDue: number; status: string } | null;
}

function createDbMock(options: string | DbMockOptions = "stripe") {
  const opts: DbMockOptions = typeof options === "string" ? { paymentMethod: options } : options;
  const currentOrder = { ...orderRow, ...opts.order, paymentMethod: opts.paymentMethod ?? "stripe" };
  const insertedValues: unknown[] = [];
  const updateQuery = {
    set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  };
  const insertQuery = {
    values: vi.fn((values: unknown) => {
      insertedValues.push(values);
      return {
      onConflictDoNothing: vi.fn(async () => undefined),
      onConflictDoUpdate: vi.fn(async () => undefined),
      };
    }),
  };
  return {
    __insertedValues: insertedValues,
    select: vi.fn(() => {
      let selectedTable: unknown = ordersTable;
      const query = {
        from: vi.fn((table: unknown) => {
          selectedTable = table;
          return query;
        }),
        where: () => query,
        get: vi.fn(async () => {
          if (selectedTable === siteSettingsTable) {
            return {
              checkoutMode: opts.checkoutMode ?? "all",
              partialPaymentEnabled: opts.partialPaymentEnabled ?? false,
              partialPaymentAmount: opts.partialPaymentAmount ?? 0,
            };
          }
          if (selectedTable === paymentPlansTable) {
            return opts.paymentPlan ?? null;
          }
          return currentOrder;
        }),
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

function createTestApp(mode: TokenMode = "valid", dbOptions: string | DbMockOptions = "stripe") {
  const db = createDbMock(dbOptions);
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
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["stripe", "sslcommerz", "polar", "cod"],
    defaultMethod: "cod",
  });
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

  it("rejects caller-selected deposits when partial payments are disabled", async () => {
    const { app, kv } = createTestApp("valid", "stripe");

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "deposit",
          depositAmount: 1,
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe intent",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz session",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar session",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      gateway: mocks.createPolarCheckout,
    },
  ])("rejects $label creation while shipment creation has an active claim", async ({ paymentMethod, path, gateway }) => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod,
      order: {
        shipmentClaimId: "shp_active",
        shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(409);
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe intent",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      settings: mocks.getStripeSettings,
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz session",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      settings: mocks.getSSLCommerzSettings,
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar session",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      settings: mocks.getPolarSettings,
      gateway: mocks.createPolarCheckout,
    },
  ].flatMap((gateway) => [
    {
      ...gateway,
      blockedState: "cancelled order",
      order: { status: OrderStatus.CANCELLED },
    },
    {
      ...gateway,
      blockedState: "returned order",
      order: { status: OrderStatus.RETURNED },
    },
    {
      ...gateway,
      blockedState: "refunded order",
      order: { status: OrderStatus.REFUNDED },
    },
    {
      ...gateway,
      blockedState: "partially refunded order",
      order: { status: OrderStatus.PARTIALLY_REFUNDED },
    },
    {
      ...gateway,
      blockedState: "soft-deleted order",
      order: { deletedAt: new Date("2026-01-01T00:00:00Z") },
    },
    {
      ...gateway,
      blockedState: "refunded payment status",
      order: { paymentStatus: PaymentStatus.REFUNDED },
    },
  ]))("rejects $label creation for a $blockedState before gateway calls", async ({
    paymentMethod,
    path,
    order,
    settings,
    gateway,
  }) => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod,
      order,
    });

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });

  it("requires deposit amount to match the configured partial payment amount", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "deposit",
          depositAmount: 49,
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("creates Stripe deposit intents from server policy and ignores manual capture/currency", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "deposit",
          depositAmount: 50,
          currency: "JPY",
          manualCapture: true,
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.getStripeSettings).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 5000,
      currency: "bdt",
      paymentType: "deposit",
      manualCapture: false,
    }));
    expect(db.__insertedValues).toContainEqual(expect.objectContaining({
      orderId: "order_1",
      totalAmount: 125,
      depositAmount: 50,
      balanceDue: 75,
    }));
  });

  it("creates SSLCommerz deposit sessions from configured amount and currency", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      partialPaymentEnabled: true,
      partialPaymentAmount: 60,
    });

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "deposit",
          depositAmount: 60,
          currency: "USD",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledWith(
      "store",
      "password",
      true,
      expect.objectContaining({
        orderId: "order_1",
        transactionId: expect.stringMatching(/^order_1_deposit_[A-F0-9]{8}$/),
        totalAmount: 60,
        currency: "BDT",
        paymentType: "deposit",
      }),
    );
  });

  it("redirects scoped SSLCommerz transaction IDs back to the canonical order ID", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/success?tran_id=order_1_deposit_ABC12345&receipt_token=chk_valid",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&token=chk_valid&payment=sslcommerz",
    );
  });

  it("creates SSLCommerz balance sessions from stored balance without inserting a new payment plan", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.PARTIAL,
        paidAmount: 60,
        balanceDue: 65,
      },
      paymentPlan: {
        balanceDue: 65,
        status: "deposit_paid",
      },
    });

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "balance",
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
        orderId: "order_1",
        transactionId: expect.stringMatching(/^order_1_balance_[A-F0-9]{8}$/),
        totalAmount: 65,
        paymentType: "balance",
      }),
    );
    expect(db.__insertedValues).toHaveLength(0);
  });

  it("creates Polar deposit sessions with original store-currency metadata", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "polar",
      partialPaymentEnabled: true,
      partialPaymentAmount: 55,
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "deposit",
          depositAmount: 55,
          currency: "USD",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.getPolarSettings).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        amount: 50,
        currency: "usd",
        paymentType: "deposit",
        metadata: expect.objectContaining({
          orderId: "order_1",
          paymentType: "deposit",
          originalAmount: "55",
          originalCurrency: "bdt",
          exchangeRate: "110",
        }),
      }),
    );
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      settings: mocks.getStripeSettings,
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      settings: mocks.getSSLCommerzSettings,
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      settings: mocks.getPolarSettings,
      gateway: mocks.createPolarCheckout,
    },
  ])("rejects stale $label checkout sessions when the payment-method allowlist is disabled", async ({
    paymentMethod,
    path,
    settings,
    gateway,
  }) => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    const { app, db, kv } = createTestApp("valid", paymentMethod);

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(503);
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
      db,
      kv,
      undefined,
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(settings).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      settings: mocks.getStripeSettings,
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      settings: mocks.getSSLCommerzSettings,
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      settings: mocks.getPolarSettings,
      gateway: mocks.createPolarCheckout,
    },
  ])("rejects stale $label checkout sessions when checkout mode switches to Fast COD Only", async ({
    paymentMethod,
    path,
    settings,
    gateway,
  }) => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod,
      checkoutMode: "guest_cod_only",
    });

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(503);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      settings: mocks.getStripeSettings,
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      settings: mocks.getSSLCommerzSettings,
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      settings: mocks.getPolarSettings,
      gateway: mocks.createPolarCheckout,
    },
  ])("rejects full $label payment sessions when partial payment requires a deposit", async ({
    paymentMethod,
    path,
    settings,
    gateway,
  }) => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod,
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          paymentType: "full",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
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
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&receipt_token=chk_valid",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1",
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
