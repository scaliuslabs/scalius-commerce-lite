import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "../../utils/api-error";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  initSSLCommerzSession: vi.fn(),
  validateSSLCommerzIPN: vi.fn(),
  createPolarCheckout: vi.fn(),
  findReusablePolarCheckout: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  getPaymentMethodPreferences: vi.fn(),
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  currentCurrencyReads: vi.fn(),
  assertNoActivePaymentSessionAttempt: vi.fn(),
  buildPaymentSessionAttemptIdentity: vi.fn(),
  claimPaymentSessionAttempt: vi.fn(),
  markPaymentSessionAttemptCreated: vi.fn(),
  markPaymentSessionAttemptFailed: vi.fn(),
  reconcileHostedPaymentReturn: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
}));

vi.mock("@scalius/core/modules/payments/sslcommerz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/sslcommerz")>()),
  initSSLCommerzSession: mocks.initSSLCommerzSession,
  validateSSLCommerzIPN: mocks.validateSSLCommerzIPN,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  createPolarCheckout: mocks.createPolarCheckout,
  findReusablePolarCheckout: mocks.findReusablePolarCheckout,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/gateway-settings")>()),
  getActivePaymentMethods: mocks.getActivePaymentMethods,
  getPaymentMethodPreferences: mocks.getPaymentMethodPreferences,
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("@scalius/core/modules/payments/payment-session-attempts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/payment-session-attempts")>()),
  assertNoActivePaymentSessionAttempt: mocks.assertNoActivePaymentSessionAttempt,
  buildPaymentSessionAttemptIdentity: mocks.buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt: mocks.claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated: mocks.markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed: mocks.markPaymentSessionAttemptFailed,
}));

vi.mock("@scalius/core/modules/payments/hosted-payment-return", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/hosted-payment-return")>()),
  reconcileHostedPaymentReturn: mocks.reconcileHostedPaymentReturn,
}));

import { polarPaymentRoutes } from "./polar-routes";
import { sslcommerzPaymentRoutes } from "./sslcommerz-routes";
import { stripePaymentRoutes } from "./stripe-routes";
import {
  createCustomerAccountPaymentSession,
  resolveCustomerPaymentSessionRecovery,
} from "./payment-session-create";
import { PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS } from "./payment-provider-deadline";
import {
  OrderStatus,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
  checkoutAttempts as checkoutAttemptsTable,
  orderPayments as orderPaymentsTable,
  orders as ordersTable,
  orderReceipts as orderReceiptsTable,
  paymentSessionAttempts as paymentSessionAttemptsTable,
  paymentPlans as paymentPlansTable,
  settings as settingsTable,
  siteSettings as siteSettingsTable,
} from "@scalius/database/schema";

const VALID_POLAR_RETURN_NONCE = `hpr_${"a".repeat(64)}`;

const orderRow = {
  id: "order_1",
  totalAmount: 125,
  totalAmountMinor: null as number | null,
  currencyCode: null as string | null,
  currencyDecimalPlaces: null as number | null,
  customerId: "customer_1" as string | null,
  accountOwnerCustomerId: "customer_1" as string | null,
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
  version: 1,
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
  paymentPlan?: { totalAmount?: number; depositAmount?: number; balanceDue: number; status: string } | null;
  paymentPlanInsertConflict?: boolean;
  currentCurrencyCode?: string | null;
  explicitUsdExchangeRate?: string | null;
  paymentRows?: Array<{ paymentMethod: string; status: string }>;
  paymentSessionAttemptRows?: Array<{ orderId: string; gateway?: string; status?: string }>;
  receiptOrderId?: string | null;
  insertError?: unknown;
  updateResult?: unknown;
  returningResult?: Array<Record<string, unknown>>;
  updateError?: unknown;
}

function createDbMock(options: string | DbMockOptions = "stripe") {
  const opts: DbMockOptions = typeof options === "string" ? { paymentMethod: options } : options;
  const currentOrder = { ...orderRow, ...opts.order, paymentMethod: opts.paymentMethod ?? "stripe" };
  const insertedValues: unknown[] = [];
  const updateSetValues: unknown[] = [];
  const resolveUpdateResult = async () => {
    if (opts.updateError) throw opts.updateError;
    return opts.updateResult;
  };
  const resolveReturningResult = async () => {
    if (opts.updateError) throw opts.updateError;
    return opts.returningResult ?? [{ id: currentOrder.id }];
  };
  const updateWhere = vi.fn(() => Object.assign(
    Promise.resolve().then(resolveUpdateResult),
    {
      returning: vi.fn(resolveReturningResult),
    },
  ));
  const updateQuery = {
    set: vi.fn((values: unknown) => {
      updateSetValues.push(values);
      return { where: updateWhere };
    }),
  };
  const insertQuery = {
    values: vi.fn((values: unknown) => {
      insertedValues.push(values);
      return {
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(async () => {
          if (opts.insertError) throw opts.insertError;
          return opts.paymentPlanInsertConflict ? [] : [{ id: "payment_plan_1" }];
        }),
      })),
      onConflictDoUpdate: vi.fn(async () => {
        if (opts.insertError) throw opts.insertError;
      }),
      };
    }),
  };
  const db = {
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
          if (selectedTable === orderReceiptsTable) {
            return opts.receiptOrderId
              ? { orderId: opts.receiptOrderId, status: "active", expiresAt: Math.floor(Date.now() / 1000) + 600 }
              : null;
          }
          if (selectedTable === checkoutAttemptsTable) {
            return null;
          }
          if (selectedTable === siteSettingsTable) {
            return {
              checkoutMode: opts.checkoutMode ?? "all",
              partialPaymentEnabled: opts.partialPaymentEnabled ?? false,
              partialPaymentAmount: opts.partialPaymentAmount ?? 0,
            };
          }
          if (selectedTable === paymentPlansTable) {
            return opts.paymentPlan
              ? { totalAmount: currentOrder.totalAmount, ...opts.paymentPlan }
              : null;
          }
          return currentOrder;
        }),
        all: vi.fn(async () => {
          if (selectedTable === settingsTable) {
            mocks.currentCurrencyReads();
            const rows: Array<{ key: string; value: string }> = [];
            if (opts.currentCurrencyCode !== null) {
              rows.push({ key: "currency_code", value: opts.currentCurrencyCode ?? "BDT" });
            }
            if (opts.explicitUsdExchangeRate !== null) {
              rows.push({ key: "usd_exchange_rate", value: opts.explicitUsdExchangeRate ?? "110" });
            }
            return rows;
          }
          if (selectedTable === orderPaymentsTable) {
            return opts.paymentRows ?? [];
          }
          if (selectedTable === paymentSessionAttemptsTable) {
            return opts.paymentSessionAttemptRows ?? [];
          }
          return [];
        }),
      };
      return query;
    }),
    update: vi.fn(() => updateQuery),
    insert: vi.fn(() => insertQuery),
    batch: vi.fn(async (statements: Array<PromiseLike<unknown>>) => Promise.all(statements)),
    __updateSetValues: updateSetValues,
  };
  return db;
}

function createKvMock(mode: TokenMode) {
  return {
    get: vi.fn(async (key: string) => {
      if (mode === "missing") return null;
      if (!key.startsWith("order_receipt:") || key.includes("chk_valid")) return null;
      return JSON.stringify({
        orderId: mode === "valid" ? "order_1" : "other_order",
      });
    }),
    put: vi.fn(async () => undefined),
  };
}

function createTestApp(mode: TokenMode = "valid", dbOptions: string | DbMockOptions = "stripe") {
  const baseOptions: DbMockOptions = typeof dbOptions === "string" ? { paymentMethod: dbOptions } : dbOptions;
  const db = createDbMock({
    ...baseOptions,
    receiptOrderId: mode === "valid" ? "order_1" : mode === "wrong" ? "other_order" : null,
  });
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

function expectNoReceiptProofInUrl(url: string | null): asserts url is string {
  expect(url).toBeTruthy();
  expect(url).not.toContain("token=");
  expect(url).not.toContain("receipt_token");
  expect(url).not.toContain("receiptToken");
}

function createPaymentRouteContext(db: ReturnType<typeof createDbMock>, kv: ReturnType<typeof createKvMock>) {
  return {
    get: vi.fn((key: string) => {
      if (key === "db") return db;
      return undefined;
    }),
    env: envFor(kv),
    req: {
      url: "https://api.example.test/api/v1/customer-auth/orders/order_1/payment-session",
    },
  } as never;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["stripe", "sslcommerz", "polar", "cod"],
    defaultMethod: "cod",
  });
  mocks.getPaymentMethodPreferences.mockResolvedValue({
    enabledMethods: ["stripe", "sslcommerz", "polar", "cod"],
    defaultMethod: "cod",
    hasExplicitEnabledMethods: true,
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
    storePassword: "ssl_store_password_123",
    sandbox: true,
  });
  mocks.initSSLCommerzSession.mockResolvedValue({
    success: true,
    gatewayUrl: "https://ssl.example.test/pay",
    sessionKey: "ssl_session_1",
  });
  mocks.validateSSLCommerzIPN.mockResolvedValue({
    status: "VALID",
    tran_id: "order_1_full_ABC12345",
    val_id: "val_1",
    amount: "125.00",
    store_amount: "125.00",
    bank_tran_id: "bank_1",
    currency_type: "BDT",
    currency_amount: "125.00",
    card_type: "VISA",
    card_brand: "VISA",
    value_a: "full",
    value_b: "order_1",
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
  mocks.findReusablePolarCheckout.mockResolvedValue(null);
  mocks.assertNoActivePaymentSessionAttempt.mockResolvedValue(undefined);
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
      attempts: 1,
    },
  });
  mocks.markPaymentSessionAttemptCreated.mockResolvedValue(undefined);
  mocks.markPaymentSessionAttemptFailed.mockResolvedValue(undefined);
  mocks.reconcileHostedPaymentReturn.mockResolvedValue("retry_ready");
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

    expect(response.status).toBe(404);
    expect(kv.get).not.toHaveBeenCalled();
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe intent",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
    },
    {
      label: "SSLCommerz session",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
    },
    {
      label: "Polar session",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
    },
  ])("creates $label with receipt proof from X-Receipt-Token", async ({ paymentMethod, path }) => {
    const { app, kv } = createTestApp("valid", paymentMethod);

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Receipt-Token": "chk_valid",
        },
        body: JSON.stringify({ orderId: "order_1" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(200);
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_1",
        receiptToken: "chk_valid",
      }),
    );
  });

  it("rejects SSLCommerz session creation when the token belongs to another order", async () => {
    const { app, db, kv } = createTestApp("wrong", "sslcommerz");

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
    expect(db.select).toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
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
      label: "full payment below provider minimum",
      dbOptions: {
        paymentMethod: "sslcommerz",
        order: {
          totalAmount: 5,
          balanceDue: 5,
        },
      },
      body: {
        orderId: "order_1",
        receiptToken: "chk_valid",
        paymentType: "full",
      },
    },
    {
      label: "deposit below provider minimum",
      dbOptions: {
        paymentMethod: "sslcommerz",
        partialPaymentEnabled: true,
        partialPaymentAmount: 5,
      },
      body: {
        orderId: "order_1",
        receiptToken: "chk_valid",
        paymentType: "deposit",
        depositAmount: 5,
      },
    },
    {
      label: "balance below provider minimum",
      dbOptions: {
        paymentMethod: "sslcommerz",
        order: {
          paymentStatus: PaymentStatus.PARTIAL,
          paidAmount: 120,
          balanceDue: 5,
        },
        paymentPlan: {
          depositAmount: 120,
          balanceDue: 5,
          status: PaymentPlanStatus.DEPOSIT_PAID,
        },
      },
      body: {
        orderId: "order_1",
        receiptToken: "chk_valid",
        paymentType: "balance",
      },
    },
    {
      label: "full payment above provider maximum",
      dbOptions: {
        paymentMethod: "sslcommerz",
        order: {
          totalAmount: 500000.01,
          balanceDue: 500000.01,
        },
      },
      body: {
        orderId: "order_1",
        receiptToken: "chk_valid",
        paymentType: "full",
      },
    },
  ])("rejects SSLCommerz $label before settings, attempts, or provider init", async ({ dbOptions, body }) => {
    const { app, kv } = createTestApp("valid", dbOptions);

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    await expect(response.clone().json()).resolves.toMatchObject({
      error: {
        message: "SSLCommerz payment amount must be between 10.00 BDT and 500000.00 BDT.",
      },
    });
    expect(mocks.getSSLCommerzSettings).not.toHaveBeenCalled();
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).not.toHaveBeenCalled();
  });

  it("creates SSLCommerz full sessions at the provider minimum amount", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        totalAmount: 10,
        balanceDue: 10,
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
          paymentType: "full",
        }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledWith(
      "store",
      "ssl_store_password_123",
      true,
      expect.objectContaining({
        orderId: "order_1",
        totalAmount: 10,
        currency: "BDT",
        paymentType: "full",
      }),
    );
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
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
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
  ])("rejects $label deposits before creating a payment plan when the gateway is not ready", async ({
    paymentMethod,
    path,
    settings,
    gateway,
  }) => {
    settings.mockResolvedValueOnce(null);
    const { app, db, kv } = createTestApp("valid", {
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
          paymentType: "deposit",
          depositAmount: 50,
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(503);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(db.__insertedValues).toHaveLength(0);
    expect(mocks.currentCurrencyReads).toHaveBeenCalledTimes(1);
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
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
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(mocks.getStripeSettings).toHaveBeenCalledWith(
      db,
      undefined,
    );
    expect(mocks.getSSLCommerzSettings).not.toHaveBeenCalled();
    expect(mocks.getPolarSettings).not.toHaveBeenCalled();
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

  it("uses the committed minor-unit order total for full payment sessions", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      order: {
        totalAmount: 40.01,
        totalAmountMinor: 4_002,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
        balanceDue: 40.02,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(expect.objectContaining({
      amount: 40.02,
      requestContext: expect.objectContaining({ amountInSmallestUnit: 4_002 }),
    }));
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 4_002,
    }));
  });

  it.each([
    {
      label: "JPY",
      order: {
        totalAmount: 100.49,
        totalAmountMinor: 100,
        currencyCode: "JPY",
        currencyDecimalPlaces: 0,
        balanceDue: 100,
      },
      expectedAmount: 100,
      expectedCurrency: "jpy",
    },
    {
      label: "KWD",
      order: {
        totalAmount: 1.2346,
        totalAmountMinor: 1_235,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
        balanceDue: 1.235,
      },
      expectedAmount: 1_235,
      expectedCurrency: "kwd",
    },
  ])("uses the immutable $label precision for full Stripe sessions", async ({
    order,
    expectedAmount,
    expectedCurrency,
  }) => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      order,
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: expectedAmount,
      currency: expectedCurrency,
    }));
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it("uses KWD precision for deposit policy and persisted payment-plan amounts", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      currentCurrencyCode: "KWD",
      partialPaymentEnabled: true,
      partialPaymentAmount: 0.6174,
      order: {
        totalAmount: 1.2346,
        totalAmountMinor: 1_235,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
        balanceDue: 1.235,
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
          paymentType: "deposit",
          depositAmount: 0.617,
        }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 617,
      currency: "kwd",
      paymentType: "deposit",
    }));
    expect(db.__insertedValues).toContainEqual(expect.objectContaining({
      orderId: "order_1",
      totalAmount: 1.235,
      depositAmount: 0.617,
      balanceDue: 0.618,
    }));
  });

  it("uses a saved KWD payment plan after current partial-payment settings change currency", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      currentCurrencyCode: "USD",
      partialPaymentEnabled: false,
      partialPaymentAmount: 999,
      order: {
        totalAmount: 1.2346,
        totalAmountMinor: 1_235,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
        balanceDue: 1.235,
      },
      paymentPlan: {
        totalAmount: 1.235,
        depositAmount: 0.617,
        balanceDue: 0.618,
        status: PaymentPlanStatus.PENDING,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 617,
      currency: "kwd",
      paymentType: "deposit",
    }));
    expect(db.__insertedValues).toHaveLength(0);
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it.each([
    { label: "inferred partial payment", partialPaymentAmount: 0.617, paymentType: undefined },
    { label: "deposit larger than the historical total", partialPaymentAmount: 5, paymentType: "deposit" },
  ])("fails closed for a no-plan KWD $label configured in current USD", async ({
    partialPaymentAmount,
    paymentType,
  }) => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      currentCurrencyCode: "USD",
      partialPaymentEnabled: true,
      partialPaymentAmount,
      order: {
        totalAmount: 1.2346,
        totalAmountMinor: 1_235,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
        balanceDue: 1.235,
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
          ...(paymentType ? { paymentType } : {}),
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("different currency") },
    });
    expect(mocks.currentCurrencyReads).toHaveBeenCalledTimes(1);
    expect(db.__insertedValues).toHaveLength(0);
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("preserves a saved order currency after the merchant changes current settings", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      currentCurrencyCode: "USD",
      order: {
        totalAmount: 40.02,
        totalAmountMinor: 4_002,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
        balanceDue: 40.02,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 4_002,
      currency: "bdt",
    }));
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it("uses BDT for truly legacy-null order snapshots regardless of current settings", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      currentCurrencyCode: "USD",
      order: {
        totalAmount: 125,
        totalAmountMinor: null,
        currencyCode: null,
        currencyDecimalPlaces: null,
        balanceDue: 125,
      },
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith("sk_test", expect.objectContaining({
      amount: 12_500,
      currency: "bdt",
    }));
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it("keeps customer recovery eligible in the immutable order currency after settings change", async () => {
    const db = createDbMock({
      paymentMethod: "stripe",
      currentCurrencyCode: "USD",
      order: {
        totalAmount: 1.2346,
        totalAmountMinor: 1_235,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
        balanceDue: 1.235,
      },
    });
    const kv = createKvMock("valid");
    const context = createPaymentRouteContext(db, kv);

    const result = await resolveCustomerPaymentSessionRecovery(context, {
      orderId: "order_1",
      expectedCustomerId: "customer_1",
    });

    expect(result).toMatchObject({
      eligible: true,
      gateway: "stripe",
      paymentType: "full",
      amountDue: 1.235,
    });
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it("offers another enabled gateway when the original failed checkout gateway is disabled", async () => {
    mocks.getPaymentMethodPreferences.mockResolvedValue({
      enabledMethods: ["sslcommerz", "cod"],
      defaultMethod: "sslcommerz",
      hasExplicitEnabledMethods: true,
    });
    const db = createDbMock({
      paymentMethod: "stripe",
      order: {
        status: OrderStatus.INCOMPLETE,
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
    });
    const context = createPaymentRouteContext(db, createKvMock("valid"));

    const result = await resolveCustomerPaymentSessionRecovery(context, {
      orderId: "order_1",
      expectedCustomerId: "customer_1",
    });

    expect(result).toMatchObject({
      eligible: true,
      gateway: "sslcommerz",
      paymentType: "full",
      amountDue: 125,
    });
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledTimes(1);
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
          paymentType: "deposit",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(500);
    expect(mocks.currentCurrencyReads).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
  });

  it("does not switch gateways or call a provider when a concurrent payment plan wins", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
      paymentPlanInsertConflict: true,
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("created concurrently") },
    });
    expect(db.__updateSetValues).toHaveLength(0);
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledWith(
      db,
      undefined,
    );
    expect(mocks.getPolarSettings).not.toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledWith(
      "store",
      "ssl_store_password_123",
      true,
      expect.objectContaining({
        orderId: "order_1",
        transactionId: expect.stringMatching(/^order_1_deposit_[A-F0-9]{8}$/),
        totalAmount: 60,
        currency: "BDT",
        paymentType: "deposit",
        signal: expect.any(AbortSignal),
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&payment_type=deposit&deposit_amount=60",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1&payment_type=deposit&deposit_amount=60",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1&payment_type=deposit&deposit_amount=60",
      }),
    );
    const sslRequest = mocks.initSSLCommerzSession.mock.calls.at(-1)?.[3] as {
      successUrl?: string;
      failUrl?: string;
      cancelUrl?: string;
    };
    expectNoReceiptProofInUrl(sslRequest.successUrl ?? null);
    expectNoReceiptProofInUrl(sslRequest.failUrl ?? null);
    expectNoReceiptProofInUrl(sslRequest.cancelUrl ?? null);
  });

  it("creates customer-account SSLCommerz balance sessions through one target-gateway context", async () => {
    const db = createDbMock({
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
    const kv = createKvMock("valid");
    const context = createPaymentRouteContext(db, kv);

    const result = await createCustomerAccountPaymentSession(context, {
      orderId: "order_1",
      customerId: "customer_1",
    });

    expect(result).toMatchObject({
      gateway: "sslcommerz",
      paymentType: "balance",
      amount: 65,
      currency: "BDT",
      hosted: {
        gatewayUrl: "https://ssl.example.test/pay",
        sessionKey: "ssl_session_1",
      },
    });
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledTimes(1);
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledWith(
      db,
      undefined,
    );
    expect(mocks.getPolarSettings).not.toHaveBeenCalled();
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledTimes(1);
    expect(mocks.initSSLCommerzSession).toHaveBeenCalledWith(
      "store",
      "ssl_store_password_123",
      true,
      expect.objectContaining({
        orderId: "order_1",
        totalAmount: 65,
        paymentType: "balance",
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&return_to=account&payment_type=balance",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1&return_to=account&payment_type=balance",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1&return_to=account&payment_type=balance",
      }),
    );
  });

  it("authorizes a claimed guest order by private account ownership instead of the merchant CRM link", async () => {
    const db = createDbMock({
      paymentMethod: "sslcommerz",
      order: {
        customerId: "guest_crm",
        accountOwnerCustomerId: "customer_1",
      },
    });
    const context = createPaymentRouteContext(db, createKvMock("valid"));

    await expect(createCustomerAccountPaymentSession(context, {
      orderId: "order_1",
      customerId: "customer_1",
    })).resolves.toMatchObject({ gateway: "sslcommerz" });

    await expect(createCustomerAccountPaymentSession(context, {
      orderId: "order_1",
      customerId: "guest_crm",
    })).rejects.toMatchObject({ status: 404 });
  });

  it("redirects scoped SSLCommerz transaction IDs back to the canonical order ID", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/success?tran_id=order_1_deposit_ABC12345",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz",
    );
    expectNoReceiptProofInUrl(location);
  });

  it("validates and queues a successful SSLCommerz buyer return before redirecting", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const env = {
      CACHE: kv,
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://shop.example.test",
      PAYMENT_EVENTS_QUEUE: queue,
    } as never;

    const response = await app.request(
      "/api/v1/payment/sslcommerz/success?order_id=order_1&payment_type=full",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          tran_id: "order_1_full_ABC12345",
          val_id: "val_1",
        }).toString(),
      },
      env,
    );

    expect(response.status).toBe(302);
    expect(mocks.validateSSLCommerzIPN).toHaveBeenCalledWith(
      "store",
      "ssl_store_password_123",
      true,
      "val_1",
      expect.any(AbortSignal),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.sslcommerz.confirmed",
      orderId: "order_1",
      paymentType: "full",
      amount: 125,
      currency: "BDT",
      webhookEventId: "sslcommerz:ipn:order_1_full_abc12345:val_1",
    }));
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&paymentType=full",
    );
  });

  it("redirects SSLCommerz failed hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/fail?order_id=order_1&payment_type=deposit&deposit_amount=60",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_deposit_ABC12345" }).toString(),
      },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&result=failed&paymentType=deposit&depositAmount=60",
    );
    expectNoReceiptProofInUrl(location);
    expect(mocks.reconcileHostedPaymentReturn).toHaveBeenCalledWith(
      expect.anything(),
      {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "deposit",
        result: "failed",
        providerCorrelationId: "order_1_deposit_ABC12345",
      },
    );
  });

  it("redirects SSLCommerz cancelled hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&payment_type=full",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_full_ABC12345" }).toString(),
      },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&result=cancelled&paymentType=full",
    );
    expectNoReceiptProofInUrl(location);
  });

  it.each(["fail", "cancel"])(
    "does not reconcile an unsigned SSLCommerz %s query-only return",
    async (resultPath) => {
      const { app, kv } = createTestApp("valid", "sslcommerz");

      const response = await app.request(
        `/api/v1/payment/sslcommerz/${resultPath}?order_id=order_1&payment_type=full&tran_id=order_1_full_ABC12345`,
        { method: "GET" },
        envFor(kv),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&paymentType=full",
      );
      expect(mocks.reconcileHostedPaymentReturn).not.toHaveBeenCalled();
    },
  );

  it("matches an SSLCommerz failed POST to its server-recorded transaction context", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/fail?order_id=order_1&payment_type=full",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_full_ABC12345" }).toString(),
      },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(mocks.reconcileHostedPaymentReturn).toHaveBeenCalledWith(
      expect.anything(),
      {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result: "failed",
        providerCorrelationId: "order_1_full_ABC12345",
      },
    );
  });

  it("does not reconcile contradictory unsigned SSLCommerz callback context", async () => {
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&payment_type=full",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "other_order_full_ABC12345" }).toString(),
      },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&paymentType=full",
    );
    expect(mocks.reconcileHostedPaymentReturn).not.toHaveBeenCalled();
  });

  it("suppresses an SSLCommerz retry result after payment already settled", async () => {
    mocks.reconcileHostedPaymentReturn.mockResolvedValueOnce("retry_suppressed");
    const { app, kv } = createTestApp("valid", "sslcommerz");

    const response = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&payment_type=full",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_full_ABC12345" }).toString(),
      },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&paymentType=full",
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
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_balance_ABC12345" }).toString(),
      },
      envFor(kv),
    );
    const cancelled = await app.request(
      "/api/v1/payment/sslcommerz/cancel?order_id=order_1&return_to=account&payment_type=balance",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tran_id: "order_1_balance_ABC12345" }).toString(),
      },
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
      expect(response.status).toBe(302);
      expectNoReceiptProofInUrl(response.headers.get("location"));
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
      "ssl_store_password_123",
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
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
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
          paymentType: "deposit",
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
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
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.getSSLCommerzSettings).not.toHaveBeenCalled();
    expect(mocks.getPolarSettings).toHaveBeenCalledWith(
      db,
      undefined,
    );
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        amount: 50,
        currency: "usd",
        paymentType: "deposit",
        successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&payment_type=deposit&deposit_amount=55",
        cancelUrl: expect.stringMatching(
          /^https:\/\/api\.example\.test\/api\/v1\/payment\/polar\/cancel\?order_id=order_1&payment_type=deposit&deposit_amount=55&return_nonce=hpr_[a-f0-9]{64}$/,
        ),
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
    const polarRequest = mocks.createPolarCheckout.mock.calls.at(-1)?.[1] as {
      successUrl?: string;
      cancelUrl?: string;
    };
    expectNoReceiptProofInUrl(polarRequest.successUrl ?? null);
    expectNoReceiptProofInUrl(polarRequest.cancelUrl ?? null);
  });

  it("fails an invalid Polar conversion without switching the order gateway", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      currentCurrencyCode: "USD",
      order: {
        totalAmount: 125,
        totalAmountMinor: 12_500,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
        balanceDue: 125,
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("different currency") },
    });
    expect(mocks.currentCurrencyReads).toHaveBeenCalledTimes(1);
    expect(db.__updateSetValues).toHaveLength(0);
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
  });

  it("rejects Polar conversion when the USD rate is only the fresh-store default", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "polar",
      explicitUsdExchangeRate: null,
      order: {
        totalAmount: 125,
        totalAmountMinor: 12_500,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
        balanceDue: 125,
      },
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("no explicit USD exchange rate") },
    });
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
  });

  it("allows an explicitly saved parity rate for an unsupported historical currency", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "polar",
      currentCurrencyCode: "BMD",
      explicitUsdExchangeRate: "1",
      order: {
        totalAmount: 125,
        totalAmountMinor: 12_500,
        currencyCode: "BMD",
        currencyDecimalPlaces: 2,
        balanceDue: 125,
      },
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        amount: 12_500,
        currency: "usd",
        paymentType: "full",
      }),
    );
  });

  it("creates a supported historical JPY Polar session without reading the current exchange rate", async () => {
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "polar",
      currentCurrencyCode: "USD",
      order: {
        totalAmount: 125.4,
        totalAmountMinor: 125,
        currencyCode: "JPY",
        currencyDecimalPlaces: 0,
        balanceDue: 125,
      },
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        amount: 125,
        currency: "jpy",
        paymentType: "full",
      }),
    );
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
  });

  it("switches a failed unpaid SSLCommerz order to Polar after target readiness passes", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );
    const json = await response.json();

    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        gatewayUrl: "https://polar.example.test/pay",
        checkoutId: "polar_checkout_1",
      },
    });
    expect(db.__updateSetValues).toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.createPolarCheckout).toHaveBeenCalledTimes(1);
    expect(mocks.createPolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        orderId: "order_1",
        paymentType: "full",
      }),
    );
  });

  it("does not replace a still-pending hosted attempt with another payable gateway session", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        status: OrderStatus.INCOMPLETE,
        paymentStatus: PaymentStatus.UNPAID,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.PENDING },
      ],
      paymentSessionAttemptRows: [
        { orderId: "order_1", gateway: "sslcommerz", status: "created" },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          replaceExistingAttempt: true,
        }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.__updateSetValues).not.toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
    }));
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
  });

  it("replays the current hosted session instead of replacing a still-pending attempt", async () => {
    mocks.claimPaymentSessionAttempt.mockResolvedValueOnce({
      status: "replay",
      attempt: {
        id: "psa_1",
        attemptKey: "payment_session:sslcommerz:hash_order_1_full",
        claimId: null,
        attempts: 1,
      },
      response: {
        gatewayUrl: "https://ssl.example.test/existing-session",
        sessionKey: "ssl_existing_session",
      },
    });
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        status: OrderStatus.INCOMPLETE,
        paymentStatus: PaymentStatus.UNPAID,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.PENDING },
      ],
      paymentSessionAttemptRows: [
        { orderId: "order_1", gateway: "sslcommerz", status: "created" },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/sslcommerz/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "chk_valid",
          replaceExistingAttempt: true,
        }),
      },
      envFor(kv),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { gatewayUrl: "https://ssl.example.test/existing-session" },
    });
    expect(db.batch).not.toHaveBeenCalled();
    expect(mocks.buildPaymentSessionAttemptIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: "sslcommerz",
        requestContext: expect.objectContaining({ orderVersion: 1 }),
      }),
    );
    expect(mocks.initSSLCommerzSession).not.toHaveBeenCalled();
  });

  it("does not switch a failed order to another gateway without failed payment evidence", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(db.__updateSetValues).not.toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
  });

  it.each([
    PaymentRecordStatus.PENDING,
    PaymentRecordStatus.CONFIRMED,
    PaymentRecordStatus.SUCCEEDED,
  ])("does not switch gateways while a %s payment row exists", async (unsafeStatus) => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
        { paymentMethod: "sslcommerz", status: unsafeStatus },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(db.__updateSetValues).not.toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
  });

  it("does not switch gateways while any payment-session setup lease is active", async () => {
    mocks.assertNoActivePaymentSessionAttempt.mockRejectedValueOnce(
      new ConflictError("Order has an active hosted payment setup in progress."),
    );
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
      paymentSessionAttemptRows: [{ orderId: "order_1" }],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(409);
    expect(db.__updateSetValues).not.toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
  });

  it("does not create a provider session when the gateway-switch CAS loses the race", async () => {
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
      returningResult: [],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(400);
    expect(db.__updateSetValues).toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
    expect(mocks.claimPaymentSessionAttempt).not.toHaveBeenCalled();
  });

  it("does not switch gateways when the target gateway is no longer checkout-visible", async () => {
    mocks.getPaymentMethodPreferences.mockResolvedValueOnce({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
      hasExplicitEnabledMethods: true,
    });
    const { app, db, kv } = createTestApp("valid", {
      paymentMethod: "sslcommerz",
      order: {
        paymentStatus: PaymentStatus.FAILED,
        paidAmount: 0,
        balanceDue: 125,
      },
      paymentRows: [
        { paymentMethod: "sslcommerz", status: PaymentRecordStatus.FAILED },
      ],
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );

    expect(response.status).toBe(503);
    expect(db.__updateSetValues).not.toContainEqual(expect.objectContaining({
      paymentMethod: "polar",
      version: 2,
    }));
    expect(mocks.getPolarSettings).not.toHaveBeenCalled();
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
  });

  it("redirects Polar cancelled hosted payments back to the receipt recovery page", async () => {
    const { app, kv } = createTestApp("valid", "polar");

    const response = await app.request(
      `/api/v1/payment/polar/cancel?order_id=order_1&payment_type=full&return_nonce=${VALID_POLAR_RETURN_NONCE}`,
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=polar&result=cancelled&paymentType=full",
    );
    expectNoReceiptProofInUrl(location);
    expect(mocks.reconcileHostedPaymentReturn).toHaveBeenCalledWith(
      expect.anything(),
      {
        orderId: "order_1",
        gateway: "polar",
        paymentType: "full",
        result: "cancelled",
        providerCorrelationId: VALID_POLAR_RETURN_NONCE,
      },
    );
  });

  it("does not reconcile a Polar cancel without a server-generated return nonce", async () => {
    const { app, kv } = createTestApp("valid", "polar");

    const response = await app.request(
      "/api/v1/payment/polar/cancel?order_id=order_1&payment_type=full",
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=polar&paymentType=full",
    );
    expect(mocks.reconcileHostedPaymentReturn).not.toHaveBeenCalled();
  });

  it("does not expose a cancelled result for a forged Polar return nonce", async () => {
    mocks.reconcileHostedPaymentReturn.mockResolvedValueOnce("ignored");
    const { app, kv } = createTestApp("valid", "polar");
    const forgedNonce = `hpr_${"b".repeat(64)}`;

    const response = await app.request(
      `/api/v1/payment/polar/cancel?order_id=order_1&payment_type=full&return_nonce=${forgedNonce}`,
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=polar&paymentType=full",
    );
    expect(mocks.reconcileHostedPaymentReturn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerCorrelationId: forgedNonce }),
    );
  });

  it("suppresses a Polar cancelled result once payment is settling or terminal", async () => {
    mocks.reconcileHostedPaymentReturn.mockResolvedValueOnce("retry_suppressed");
    const { app, kv } = createTestApp("valid", "polar");

    const response = await app.request(
      `/api/v1/payment/polar/cancel?order_id=order_1&payment_type=full&return_nonce=${VALID_POLAR_RETURN_NONCE}`,
      { method: "GET" },
      envFor(kv),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://shop.example.test/order-success?orderId=order_1&payment=polar&paymentType=full",
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
      `/api/v1/payment/polar/cancel?order_id=order_1&return_to=account&payment_type=balance&return_nonce=${VALID_POLAR_RETURN_NONCE}`,
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
      expect(response.status).toBe(302);
      expectNoReceiptProofInUrl(response.headers.get("location"));
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
        attempts: 1,
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
    if (paymentMethod === "polar") {
      const firstClaimInput = mocks.claimPaymentSessionAttempt.mock.calls.at(-2)?.[1] as {
        providerCorrelationId?: string;
      };
      const replayClaimInput = mocks.claimPaymentSessionAttempt.mock.calls.at(-1)?.[1] as {
        providerCorrelationId?: string;
      };
      expect(firstClaimInput.providerCorrelationId).toMatch(/^hpr_[a-f0-9]{64}$/);
      expect(replayClaimInput.providerCorrelationId).toBe(firstClaimInput.providerCorrelationId);

      const providerRequest = mocks.createPolarCheckout.mock.calls.at(-1)?.[1] as {
        cancelUrl?: string;
      };
      const cancelUrl = new URL(providerRequest.cancelUrl ?? "https://invalid.example");
      expect(cancelUrl.searchParams.get("return_nonce")).toBe(firstClaimInput.providerCorrelationId);
      expect(providerRequest.cancelUrl).not.toContain("chk_valid");
    }
  });

  it("recovers a reclaimed Polar checkout before creating another provider session", async () => {
    const { app, db, kv } = createTestApp("valid", "polar");
    mocks.claimPaymentSessionAttempt.mockResolvedValueOnce({
      status: "claimed",
      attempt: {
        id: "psa_1",
        attemptKey: "payment_session:polar:hash_order_1_full",
        claimId: "psac_1",
        attempts: 2,
      },
    });
    mocks.findReusablePolarCheckout.mockResolvedValueOnce({
      success: true,
      checkoutUrl: "https://polar.example.test/recovered",
      checkoutId: "polar_checkout_recovered",
      recovered: true,
    });

    const response = await app.request(
      "/api/v1/payment/polar/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        gatewayUrl: "https://polar.example.test/recovered",
        checkoutId: "polar_checkout_recovered",
      },
    });
    expect(mocks.findReusablePolarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "polar_product" }),
      expect.objectContaining({
        orderId: "order_1",
        idempotencyKey: "payment_session:polar:hash_order_1_full",
        paymentType: "full",
        productId: "polar_product",
      }),
    );
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptCreated).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "psa_1", claimId: "psac_1", attempts: 2 }),
      {
        providerSessionId: "polar_checkout_recovered",
        response: {
          gatewayUrl: "https://polar.example.test/recovered",
          checkoutId: "polar_checkout_recovered",
        },
      },
    );
  });

  it("awaits the durable payment-session attempt before returning the provider response", async () => {
    const created = deferred();
    mocks.markPaymentSessionAttemptCreated.mockReturnValueOnce(created.promise);
    const hintWrite = deferred();
    const executionCtx = { waitUntil: vi.fn() };
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      updateResult: hintWrite.promise,
    });

    const responsePromise = Promise.resolve(app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
      executionCtx as never,
    ));
    const race = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);

    expect(race).toBe("pending");
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();

    created.resolve(undefined);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

    hintWrite.resolve(undefined);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
    },
  ])("schedules the $label order recovery hint after the response when executionCtx is available", async ({
    paymentMethod,
    path,
  }) => {
    const hintWrite = deferred();
    const executionCtx = { waitUntil: vi.fn() };
    const { app, kv } = createTestApp("valid", {
      paymentMethod,
      updateResult: hintWrite.promise,
    });

    const responsePromise = Promise.resolve(app.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
      executionCtx as never,
    ));
    const race = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    if (race !== "response") {
      hintWrite.resolve(undefined);
      await responsePromise;
    }

    expect(race).toBe("response");
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

    hintWrite.resolve(undefined);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
  });

  it("logs order recovery hint failures without failing a created Stripe session", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executionCtx = { waitUntil: vi.fn() };
    const { app, kv } = createTestApp("valid", {
      paymentMethod: "stripe",
      updateError: new Error("D1 hint write failed"),
    });

    const response = await app.request(
      "/api/v1/payment/stripe/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1", receiptToken: "chk_valid" }),
      },
      envFor(kv),
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await expect(executionCtx.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[payments] Stripe session was created, but local order recovery hint failed:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
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
    mocks.claimPaymentSessionAttempt.mockResolvedValueOnce({
      status: "processing",
      retryable: true,
      retryAfterSeconds: 2,
      orderId: "order_1",
      gateway: paymentMethod,
      paymentType: "full",
      message: "Payment session creation is already processing. Please try again shortly.",
    });
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
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toEqual({
      success: true,
      data: {
        status: "processing",
        retryable: true,
        retryAfterSeconds: 2,
        orderId: "order_1",
        gateway: paymentMethod,
        paymentType: "full",
        message: "Payment session creation is already processing. Please try again shortly.",
      },
    });
    expect(gateway).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptCreated).not.toHaveBeenCalled();
    expect(mocks.markPaymentSessionAttemptFailed).not.toHaveBeenCalled();
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
    mocks.getPaymentMethodPreferences.mockResolvedValue({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
      hasExplicitEnabledMethods: true,
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
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(settings).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe",
      paymentMethod: "stripe",
      path: "/api/v1/payment/stripe/intent",
      settings: mocks.getStripeSettings,
      disabledSettings: {
        enabled: false,
        secretKey: "sk_test",
        publishableKey: "pk_test",
        webhookSecret: "whsec_test",
      },
      otherSettings: [mocks.getSSLCommerzSettings, mocks.getPolarSettings],
      gateway: mocks.createPaymentIntent,
      message: "Stripe gateway is disabled.",
    },
    {
      label: "SSLCommerz",
      paymentMethod: "sslcommerz",
      path: "/api/v1/payment/sslcommerz/session",
      settings: mocks.getSSLCommerzSettings,
      disabledSettings: {
        enabled: false,
        storeId: "store",
        storePassword: "ssl_store_password_123",
        sandbox: true,
      },
      otherSettings: [mocks.getStripeSettings, mocks.getPolarSettings],
      gateway: mocks.initSSLCommerzSession,
      message: "SSLCommerz gateway is disabled.",
    },
    {
      label: "Polar",
      paymentMethod: "polar",
      path: "/api/v1/payment/polar/session",
      settings: mocks.getPolarSettings,
      disabledSettings: {
        enabled: false,
        accessToken: "polar_token",
        productId: "polar_product",
        webhookSecret: "polar_webhook",
        sandbox: true,
      },
      otherSettings: [mocks.getStripeSettings, mocks.getSSLCommerzSettings],
      gateway: mocks.createPolarCheckout,
      message: "Polar gateway is disabled.",
    },
  ])("rejects selected $label sessions when the provider is not checkout-ready", async ({
    paymentMethod,
    path,
    settings,
    disabledSettings,
    otherSettings,
    gateway,
    message,
  }) => {
    settings.mockResolvedValueOnce(disabledSettings);
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
    expect(json.error.message).toBe(message);
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getPaymentMethodPreferences).toHaveBeenCalledWith(db);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(settings).toHaveBeenCalledWith(
      db,
      undefined,
    );
    for (const otherSetting of otherSettings) {
      expect(otherSetting).not.toHaveBeenCalled();
    }
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
    expect(mocks.currentCurrencyReads).not.toHaveBeenCalled();
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
    expect(mocks.currentCurrencyReads).toHaveBeenCalledTimes(1);
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
      "ssl_store_password_123",
      true,
      expect.objectContaining({
        successUrl: "https://api.example.test/api/v1/payment/sslcommerz/success?order_id=order_1&payment_type=full",
        failUrl: "https://api.example.test/api/v1/payment/sslcommerz/fail?order_id=order_1&payment_type=full",
        cancelUrl: "https://api.example.test/api/v1/payment/sslcommerz/cancel?order_id=order_1&payment_type=full",
        ipnUrl: "https://api.example.test/api/v1/webhooks/sslcommerz",
      }),
    );
    const sslRequest = mocks.initSSLCommerzSession.mock.calls.at(-1)?.[3] as {
      successUrl?: string;
      failUrl?: string;
      cancelUrl?: string;
    };
    expectNoReceiptProofInUrl(sslRequest.successUrl ?? null);
    expectNoReceiptProofInUrl(sslRequest.failUrl ?? null);
    expectNoReceiptProofInUrl(sslRequest.cancelUrl ?? null);
    const identityInput = mocks.buildPaymentSessionAttemptIdentity.mock.calls.at(-1)?.[0] as {
      requestContext?: Record<string, unknown>;
    };
    expect(identityInput.requestContext).not.toHaveProperty("retryKey");
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
        successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&payment_type=full",
        cancelUrl: expect.stringMatching(
          /^https:\/\/api\.example\.test\/api\/v1\/payment\/polar\/cancel\?order_id=order_1&payment_type=full&return_nonce=hpr_[a-f0-9]{64}$/,
        ),
      }),
    );
    const polarRequest = mocks.createPolarCheckout.mock.calls.at(-1)?.[1] as {
      successUrl?: string;
      cancelUrl?: string;
    };
    expectNoReceiptProofInUrl(polarRequest.successUrl ?? null);
    expectNoReceiptProofInUrl(polarRequest.cancelUrl ?? null);
    const identityInput = mocks.buildPaymentSessionAttemptIdentity.mock.calls.at(-1)?.[0] as {
      requestContext?: Record<string, unknown>;
    };
    expect(identityInput.requestContext).not.toHaveProperty("retryKey");
    expect(identityInput.requestContext).toMatchObject({
      successUrl: "https://api.example.test/api/v1/payment/polar/success?order_id=order_1&payment_type=full",
      cancelUrl: "https://api.example.test/api/v1/payment/polar/cancel?order_id=order_1&payment_type=full",
    });
  });
});
