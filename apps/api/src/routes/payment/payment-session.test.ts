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
  buildPaymentSessionAttemptIdentity: vi.fn(),
  claimPaymentSessionAttempt: vi.fn(),
  markPaymentSessionAttemptCreated: vi.fn(),
  markPaymentSessionAttemptFailed: vi.fn(),
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

vi.mock("@scalius/core/modules/payments/gateway-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/gateway-settings")>()),
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getActivePaymentMethods: mocks.getActivePaymentMethods,
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("@scalius/core/modules/payments/payment-session-attempts", () => ({
  buildPaymentSessionAttemptIdentity: mocks.buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt: mocks.claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated: mocks.markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed: mocks.markPaymentSessionAttemptFailed,
}));

import { polarPaymentRoutes } from "./polar-routes";
import { sslcommerzPaymentRoutes } from "./sslcommerz-routes";
import { stripePaymentRoutes } from "./stripe-routes";
import { PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS } from "./payment-provider-deadline";
import {
  OrderStatus,
  PaymentPlanStatus,
  PaymentStatus,
  orders as ordersTable,
  paymentPlans as paymentPlansTable,
  siteSettings as siteSettingsTable,
} from "@scalius/database/schema";
import { ConflictError } from "../../utils/api-error";

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
  paymentPlan?: { depositAmount?: number; balanceDue: number; status: string } | null;
  insertError?: unknown;
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
      onConflictDoNothing: vi.fn(async () => {
        if (opts.insertError) throw opts.insertError;
      }),
      onConflictDoUpdate: vi.fn(async () => {
        if (opts.insertError) throw opts.insertError;
      }),
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
    webhookSecret: "whsec_test",
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
    webhookSecret: "polar_webhook",
    sandbox: true,
  });
  mocks.createPolarCheckout.mockResolvedValue({
    success: true,
    checkoutUrl: "https://polar.example.test/pay",
    checkoutId: "polar_checkout_1",
  });
  mocks.buildPaymentSessionAttemptIdentity.mockImplementation(async (input: {
    orderId: string;
    gateway: string;
    paymentType: string;
    amount: number;
    currency: string;
  }) => ({
    attemptKey: `payment_session:${input.gateway}:hash_${input.orderId}_${input.paymentType}`,
    requestHash: `hash_${input.orderId}_${input.paymentType}`,
    transactionSuffix: "ABC12345",
    orderId: input.orderId,
    gateway: input.gateway,
    paymentType: input.paymentType,
    amount: input.amount,
    currency: input.currency.toLowerCase(),
  }));
  mocks.claimPaymentSessionAttempt.mockResolvedValue({
    status: "claimed",
    attempt: {
      id: "psa_1",
      attemptKey: "payment_session:stripe:hash_order_1_full",
      claimId: "psac_1",
    },
  });
  mocks.markPaymentSessionAttemptCreated.mockResolvedValue(undefined);
  mocks.markPaymentSessionAttemptFailed.mockResolvedValue(undefined);
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
      requestTimeoutMs: PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: 0,
    }));
    expect(db.__insertedValues).toContainEqual(expect.objectContaining({
      orderId: "order_1",
      totalAmount: 125,
      depositAmount: 50,
      balanceDue: 75,
    }));
  });

  it("derives Stripe deposit sessions on the server when the browser omits payment type", async () => {
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
        }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(expect.objectContaining({
      paymentType: "deposit",
      amount: 50,
    }));
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 5000,
      paymentType: "deposit",
    }));
    expect(db.__insertedValues).toContainEqual(expect.objectContaining({
      orderId: "order_1",
      depositAmount: 50,
      balanceDue: 75,
      status: PaymentPlanStatus.PENDING,
    }));
  });

  it("derives full Stripe sessions when the configured deposit is not below the committed order total", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
      order: {
        totalAmount: 40,
        balanceDue: 40,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
        }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(expect.objectContaining({
      paymentType: "full",
      amount: 40,
    }));
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 4000,
      paymentType: "full",
    }));
    expect(db.__insertedValues).toHaveLength(0);
  });

  it("fails before provider calls when a pending deposit payment plan cannot be persisted", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
      insertError: new Error("D1 write failed"),
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(500);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
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
        signal: expect.any(AbortSignal),
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=60",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=60",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=60",
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

  it("redirects SSLCommerz failed hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/fail?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=60",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&token=chk_valid&payment=sslcommerz&result=failed&paymentType=deposit&depositAmount=60",
    );
  });

  it("redirects SSLCommerz cancelled hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=full",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&token=chk_valid&payment=sslcommerz&result=cancelled&paymentType=full",
    );
  });

  it("redirects SSLCommerz account callbacks without exposing receipt tokens", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const success = await app.request(
      "/api/v1/payment/sslcommerz/success?order_id=order_1&return_to=account&payment_type=balance",
      { method: "GET" },
      envFor(kv),
    );
    const failed = await app.request(
      "/api/v1/payment/sslcommerz/fail?order_id=order_1&return_to=account&payment_type=balance",
      { method: "GET" },
      envFor(kv),
    );
    const cancelled = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&return_to=account&payment_type=balance",
      { method: "GET" },
      envFor(kv),
    );

    expect(success.headers.get("location")).toBe(
      "https://shop.example.test/account/orders/order_1?payment=sslcommerz&paymentType=balance",
    );
    expect(failed.headers.get("location")).toBe(
      "https://shop.example.test/account/orders/order_1?payment=sslcommerz&result=failed&paymentType=balance",
    );
    expect(cancelled.headers.get("location")).toBe(
      "https://shop.example.test/account/orders/order_1?payment=sslcommerz&result=cancelled&paymentType=balance",
    );
    for (const response of [success, failed, cancelled]) {
      const location = response.headers.get("location") ?? "";
      expect(response.status).toBe(302);
      expect(location).not.toContain("token=");
      expect(location).not.toContain("receipt_token");
    }
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
        depositAmount: 60,
        balanceDue: 65,
        status: PaymentPlanStatus.DEPOSIT_PAID,
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

  it("rejects balance sessions until the deposit has been confirmed locally", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.PARTIAL,
        paidAmount: 60,
        balanceDue: 65,
      },
      paymentPlan: {
        depositAmount: 60,
        balanceDue: 65,
        status: PaymentPlanStatus.PENDING,
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

    expect(response.status).toBe(400);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(mocks.getSSLCommerzSettings).not.toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).not.toHaveBeenCalled();
  });

  it("rejects a second deposit session after a partial payment has been recorded", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
      order: {
        paymentStatus: PaymentStatus.PARTIAL,
        paidAmount: 50,
        balanceDue: 75,
      },
      paymentPlan: {
        depositAmount: 50,
        balanceDue: 75,
        status: PaymentPlanStatus.DEPOSIT_PAID,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
        successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=55",
        cancelUrl: "https://api.example.test/api/v1/payment/polar/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=deposit&deposit_amount=55",
        metadata: expect.objectContaining({
          orderId: "order_1",
          paymentType: "deposit",
          originalAmount: "55",
          originalCurrency: "bdt",
          exchangeRate: "110",
        }),
        requestTimeoutMs: PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("redirects Polar cancelled hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "polar");

    const response = await app.request(
      "/api/v1/payment/polar/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=full",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&token=chk_valid&payment=polar&result=cancelled&paymentType=full",
    );
  });

  it("redirects Polar account callbacks without exposing receipt tokens", async () => {
    const { app, kv } = createTestApp("valid", "polar");

    const success = await app.request(
      "/api/v1/payment/polar/success?order_id=order_1&return_to=account&payment_type=balance",
      { method: "GET" },
      envFor(kv),
    );
    const cancelled = await app.request(
      "/api/v1/payment/polar/cancel?order_id=order_1&return_to=account&payment_type=balance",
      { method: "GET" },
      envFor(kv),
    );

    expect(success.headers.get("location")).toBe(
      "https://shop.example.test/account/orders/order_1?payment=polar&paymentType=balance",
    );
    expect(cancelled.headers.get("location")).toBe(
      "https://shop.example.test/account/orders/order_1?payment=polar&result=cancelled&paymentType=balance",
    );
    for (const response of [success, cancelled]) {
      const location = response.headers.get("location") ?? "";
      expect(response.status).toBe(302);
      expect(location).not.toContain("token=");
      expect(location).not.toContain("receipt_token");
    }
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      gateway: mocks.createPolarCheckout,
    },
  ])("replays a created $label session without a second provider call", async ({ paymentMethod, path, gateway }) => {
    const { app, db, kv } = createTestApp("valid", paymentMethod);
    mocks.claimPaymentSessionAttempt.mockResolvedValueOnce({
      status: "claimed",
      attempt: {
        id: "psa_1",
        attemptKey: `payment_session:${paymentMethod}:hash_order_1_full`,
        claimId: "psac_1",
      },
    });

    const first = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );
    const firstJson = await first.json() as { data: Record<string, unknown> };
    mocks.claimPaymentSessionAttempt.mockResolvedValueOnce({
      status: "replay",
      response: firstJson.data,
    });

    const second = await app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ success: true, data: firstJson.data });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(mocks.markPaymentSessionAttemptCreated).toHaveBeenCalledTimes(1);
    expect(mocks.markPaymentSessionAttemptCreated).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "psa_1", claimId: "psac_1" }),
      expect.objectContaining({ response: firstJson.data }),
    );
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      gateway: mocks.createPaymentIntent,
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      gateway: mocks.initSSLCommerzSession,
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      gateway: mocks.createPolarCheckout,
    },
  ])("does not create a second $label session while an attempt is already processing", async ({
    paymentMethod,
    path,
    gateway,
  }) => {
    mocks.claimPaymentSessionAttempt.mockRejectedValueOnce(
      new ConflictError("A payment session is already being created for this order. Please try again shortly."),
    );
    const { app, kv } = createTestApp("valid", paymentMethod);

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
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
  });

  it("marks failed Stripe attempts before surfacing provider creation errors", async () => {
    mocks.createPaymentIntent.mockResolvedValueOnce({
      success: false,
      error: "Stripe unavailable",
    });
    const { app, db, kv } = createTestApp("valid", "stripe");

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(500);
    expect(mocks.markPaymentSessionAttemptFailed).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "psa_1", claimId: "psac_1" }),
      "Stripe unavailable",
    );
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      gateway: mocks.createPaymentIntent,
      timeoutResult: {
        success: false,
        error: "Stripe did not respond before the payment timeout. Please try again.",
        timedOut: true,
      },
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      gateway: mocks.initSSLCommerzSession,
      timeoutResult: {
        success: false,
        error: "SSLCommerz did not respond before the payment timeout. Please try again.",
        timedOut: true,
      },
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      gateway: mocks.createPolarCheckout,
      timeoutResult: {
        success: false,
        error: "Polar did not respond before the payment timeout. Please try again.",
        timedOut: true,
      },
    },
  ])("maps $label provider deadline results to retryable 503 responses", async ({
    paymentMethod,
    path,
    gateway,
    timeoutResult,
  }) => {
    gateway.mockResolvedValueOnce(timeoutResult);
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
    const json = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(json.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(json.error.message).toContain("did not respond in time");
    expect(mocks.markPaymentSessionAttemptFailed).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "psa_1", claimId: "psac_1" }),
      timeoutResult.error,
    );
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
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
          retryKey: "retry_1",
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
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&receipt_token=chk_valid&payment_type=full",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1&receipt_token=chk_valid&payment_type=full",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=full",
        ipnUrl: "https://api.example.test/api/v1/webhooks/sslcommerz",
      }),
    );
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        requestContext: expect.objectContaining({ retryKey: "retry_1" }),
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
          retryKey: "retry_2",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&receipt_token=chk_valid&payment_type=full",
        cancelUrl: "https://api.example.test/api/v1/payment/polar/cancel?order_id=order_1&receipt_token=chk_valid&payment_type=full",
      }),
    );
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        requestContext: expect.objectContaining({ retryKey: "retry_2" }),
      }),
    );
  });
});
