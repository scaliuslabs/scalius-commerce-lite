import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@scalius/core/errors";
import { ValidationError } from "../utils/api-error";
import { errorResponseFromError } from "../utils/api-response";
import { getReceiptTokenKvKey } from "../utils/order-receipt-token";

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  buildCheckoutAttemptIdentity: vi.fn(),
  resolveExistingCheckoutAttempt: vi.fn(),
  claimCheckoutAttempt: vi.fn(),
  markCheckoutAttemptCommitted: vi.fn(),
  markCheckoutAttemptFailed: vi.fn(),
  commitStorefrontOrderPayload: vi.fn(),
  runStorefrontOrderPostCommitSideEffects: vi.fn(),
  validateStorefrontCartItems: vi.fn(),
  validateStorefrontDeliveryPreflight: vi.fn(),
  createReceiptOrderSupportRequest: vi.fn(),
  getOrderSupportRequestStatusLabel: vi.fn((status: string) => status),
  getReceiptOrderSupportRequestState: vi.fn(),
  invalidateProductAvailabilityCaches: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
  getCustomerBySession: vi.fn(),
  getActivePaymentMethods: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
  return {
    ...actual,
    CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES: ["cancel_pre_shipment", "return", "refund"],
    buildCheckoutAttemptIdentity: mocks.buildCheckoutAttemptIdentity,
    resolveExistingCheckoutAttempt: mocks.resolveExistingCheckoutAttempt,
    claimCheckoutAttempt: mocks.claimCheckoutAttempt,
    createReceiptOrderSupportRequest: mocks.createReceiptOrderSupportRequest,
    createStorefrontOrder: mocks.createStorefrontOrder,
    getOrderSupportRequestStatusLabel: mocks.getOrderSupportRequestStatusLabel,
    getReceiptOrderSupportRequestState: mocks.getReceiptOrderSupportRequestState,
    markCheckoutAttemptCommitted: mocks.markCheckoutAttemptCommitted,
    markCheckoutAttemptFailed: mocks.markCheckoutAttemptFailed,
    commitStorefrontOrderPayload: mocks.commitStorefrontOrderPayload,
    runStorefrontOrderPostCommitSideEffects: mocks.runStorefrontOrderPostCommitSideEffects,
    validateStorefrontCartItems: mocks.validateStorefrontCartItems,
    validateStorefrontDeliveryPreflight: mocks.validateStorefrontDeliveryPreflight,
  };
});

vi.mock("../utils/cache-invalidation", () => ({
  getOptionalExecutionContext: (c: { executionCtx?: unknown }) => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  },
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  getClientIp: mocks.getClientIp,
}));

vi.mock("@scalius/core/modules/customers/customer-auth.service", () => ({
  getCustomerBySession: mocks.getCustomerBySession,
  getSessionCookie: (cookieHeader: string | null) => {
    const match = cookieHeader?.match(/(?:^|;\s*)cs_tok=([^;]+)/);
    return match?.[1] ?? null;
  },
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getActivePaymentMethods: mocks.getActivePaymentMethods,
}));

import { orderRoutes } from "./orders";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.getCustomerBySession.mockResolvedValue(null);
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["cod"],
    defaultMethod: "cod",
  });
  mocks.buildCheckoutAttemptIdentity.mockResolvedValue({
    requestKey: "checkout_submit:v1:test",
    requestHash: "request_hash_1",
    checkoutRequestId: "checkout_req_123456",
  });
  mocks.resolveExistingCheckoutAttempt.mockResolvedValue(null);
  mocks.claimCheckoutAttempt.mockResolvedValue({
    status: "claimed",
    attempt: {
      id: "coa_1",
      requestKey: "checkout_submit:v1:test",
      requestHash: "request_hash_1",
      claimId: "coac_1",
      orderId: "order_1",
      checkoutToken: "chk_order_1",
    },
  });
  mocks.markCheckoutAttemptCommitted.mockResolvedValue(undefined);
  mocks.markCheckoutAttemptFailed.mockResolvedValue(undefined);
  mocks.commitStorefrontOrderPayload.mockResolvedValue(undefined);
  mocks.runStorefrontOrderPostCommitSideEffects.mockResolvedValue(undefined);
  mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
  mocks.validateStorefrontCartItems.mockResolvedValue({
    valid: true,
    issues: [],
    items: [],
    subtotal: 0,
    hasFreeDeliveryProduct: false,
  });
  mocks.validateStorefrontDeliveryPreflight.mockResolvedValue({
    shippingCharge: 60,
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
  });
});

const validOrderBody = {
  checkoutRequestId: "checkout_req_123456",
  customerName: "Queue Customer",
  customerPhone: "+8801712345678",
  customerEmail: null,
  shippingAddress: "123 Queue Street",
  city: "city_1",
  zone: "zone_1",
  area: null,
  notes: null,
  items: [
    {
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Queue Product",
      variantLabel: null,
    },
  ],
  discountAmount: null,
  shippingCharge: 0,
  paymentMethod: "cod",
  inventoryPool: "regular",
};

function createTestApp(options: {
  guestCheckoutEnabled?: boolean;
  checkoutMode?: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled?: boolean;
  partialPaymentAmount?: number;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
} = {}) {
  const calls: string[] = [];
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string) => {
      calls.push(`kv:${key}`);
    }),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{
          guestCheckoutEnabled: options.guestCheckoutEnabled ?? true,
          checkoutMode: options.checkoutMode ?? "all",
          partialPaymentEnabled: options.partialPaymentEnabled ?? false,
          partialPaymentAmount: options.partialPaymentAmount ?? 0,
        }]),
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            if (!options.allowedCountries?.length) return null;
            return {
              value: JSON.stringify({
                countries: options.allowedCountries,
                mode: options.allowedCountriesMode ?? "include",
              }),
            };
          }),
        })),
      })),
    })),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, db, kv, calls };
}

function createStatusTestApp(options: {
  kvStatus?: Record<string, unknown> | null;
  attempt?: {
    status: "committed" | "failed" | "processing";
    orderId: string;
    checkoutToken: string;
    lastError?: string | null;
  } | null;
  orderExists?: boolean;
}) {
  let selectCount = 0;
  const kv = {
    get: vi.fn(async (key: string): Promise<string | null> => {
      if (key !== "checkout_status:chk_status") return null;
      return options.kvStatus ? JSON.stringify(options.kvStatus) : null;
    }),
    put: vi.fn(async (_key: string, _value: string, _options?: { expirationTtl: number }) => undefined),
  };
  const db = {
    select: vi.fn(() => {
      selectCount += 1;
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        get: vi.fn(async () => {
          if (!options.kvStatus && selectCount === 1) {
            return options.attempt ?? null;
          }
          return options.orderExists ? { id: options.attempt?.orderId ?? "order_1" } : null;
        }),
        limit: vi.fn(async () => options.orderExists ? [{ id: "order_1" }] : []),
      };
      return query;
    }),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, db, kv };
}

function createWaitUntilContext() {
  return {
    waitUntil: vi.fn((_promise: Promise<unknown>) => undefined),
    passThroughOnException: vi.fn(),
  };
}

describe("cart validation preflight", () => {
  it("returns every cart item issue without creating checkout side effects", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: false,
      issues: [
        {
          index: 0,
          cartKey: "line_1",
          productId: "product_1",
          variantId: "variant_1",
          code: "QUANTITY_UNAVAILABLE",
          action: "reduce_quantity",
          message: "Only 2 left for Queue Product.",
          productName: "Queue Product",
          variantLabel: null,
          requestedQuantity: 5,
          availableQuantity: 2,
        },
      ],
      items: [],
      subtotal: 0,
      hasFreeDeliveryProduct: false,
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 5,
              price: 100,
              productName: "Queue Product",
            },
          ],
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        valid: false,
        issues: [
          {
            cartKey: "line_1",
            code: "QUANTITY_UNAVAILABLE",
            message: "Only 2 left for Queue Product.",
            availableQuantity: 2,
          },
        ],
      },
    });
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.validateStorefrontDeliveryPreflight).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("preflights selected delivery data when cart validation receives city and zone", async () => {
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 1,
              price: 100,
              productName: "Queue Product",
            },
          ],
          city: "city_1",
          zone: "zone_1",
          area: null,
          shippingMethodId: "ship_1",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        valid: true,
        delivery: {
          shippingCharge: 60,
          cityName: "Dhaka",
          zoneName: "Mirpur",
        },
      },
    });
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledWith(
      expect.anything(),
      {
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: "ship_1",
      },
      expect.objectContaining({ valid: true }),
    );
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("surfaces stale delivery choices from cart validation without creating checkout side effects", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("A valid active shipping method is required for this order."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 1,
              price: 100,
              productName: "Queue Product",
            },
          ],
          city: "city_1",
          zone: "zone_1",
          shippingMethodId: "ship_stale",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "A valid active shipping method is required for this order.",
      },
    });
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("checkout status recovery hints", () => {
  it("repairs checkout status and receipt KV after a committed D1 fallback", async () => {
    const { app, kv } = createStatusTestApp({
      attempt: {
        status: "committed",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      "/api/v1/orders/status/chk_status",
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
        receiptToken: "chk_status",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const receiptKey = await getReceiptTokenKvKey("chk_status");
    const statusWrite = kv.put.mock.calls.find(([key]) => key === "checkout_status:chk_status");
    const receiptWrite = kv.put.mock.calls.find(([key]) => key === receiptKey);
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "completed",
      orderId: "order_1",
      receiptToken: "chk_status",
    });
    expect(statusWrite?.[2]).toEqual({ expirationTtl: 86400 });
    expect(receiptKey).not.toContain("chk_status");
    expect(JSON.parse(String(receiptWrite?.[1]))).toEqual({ orderId: "order_1" });
    expect(receiptWrite?.[2]).toEqual({ expirationTtl: 60 * 60 * 24 * 7 });
  });

  it("repairs success hints when a processing D1 attempt already has an order", async () => {
    const { app, kv } = createStatusTestApp({
      attempt: {
        status: "processing",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
      orderExists: true,
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      "/api/v1/orders/status/chk_status",
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
        receiptToken: "chk_status",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const receiptKey = await getReceiptTokenKvKey("chk_status");
    expect(kv.put.mock.calls.map(([key]) => key)).toEqual([
      "checkout_status:chk_status",
      receiptKey,
    ]);
  });

  it("repairs stale processing KV when the order is already committed", async () => {
    const { app, kv } = createStatusTestApp({
      kvStatus: {
        status: "processing",
        orderId: "order_1",
        updatedAt: Date.now() - 60_000,
      },
      orderExists: true,
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      "/api/v1/orders/status/chk_status",
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
        receiptToken: "chk_status",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusWrite = kv.put.mock.calls.find(([key]) => key === "checkout_status:chk_status");
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "completed",
      orderId: "order_1",
    });
  });

  it("repairs failed checkout status after a failed D1 fallback", async () => {
    const { app, kv } = createStatusTestApp({
      attempt: {
        status: "failed",
        orderId: "order_1",
        checkoutToken: "chk_status",
        lastError: "Discount code has reached its usage limit",
      },
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      "/api/v1/orders/status/chk_status",
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: "failed",
        orderId: "order_1",
        error: "Discount code has reached its usage limit",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusWrite = kv.put.mock.calls.find(([key]) => key === "checkout_status:chk_status");
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_1",
      error: "Discount code has reached its usage limit",
    });
    expect(kv.put.mock.calls.some(([key]) => String(key).startsWith("order_receipt:"))).toBe(false);
  });
});

describe("create order commit/KV ordering", () => {
  it("commits the order before scheduling checkout recovery hints and side effects", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      commitPayload: { orderData: { id: "order_1" } },
    });
    const { app, kv, calls } = createTestApp();
    const neverSettles = new Promise<never>(() => undefined);
    kv.put.mockImplementation(async (key: string) => {
      calls.push(`kv:${key}`);
      await neverSettles;
    });
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };
    mocks.commitStorefrontOrderPayload.mockImplementation(async () => {
      calls.push("commit");
    });
    mocks.markCheckoutAttemptCommitted.mockImplementation(async () => {
      calls.push("mark-committed");
    });
    mocks.runStorefrontOrderPostCommitSideEffects.mockImplementation(async () => {
      calls.push("side-effects");
    });
    mocks.invalidateProductAvailabilityCaches.mockImplementation(async () => {
      calls.push("availability");
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
      executionCtx as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    const receiptKey = await getReceiptTokenKvKey("chk_order_1");
    expect(calls.slice(0, 2)).toEqual(["commit", "mark-committed"]);
    expect(calls).toContain("kv:checkout_status:chk_order_1");
    expect(calls).toContain(`kv:${receiptKey}`);
    expect(calls).toContain("side-effects");
    expect(calls).toContain("availability");
    expect(receiptKey).not.toContain("chk_order_1");
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(2);
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderData: { id: "order_1" } }),
    );
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkoutRequestId: "checkout_req_123456" }),
      expect.any(String),
      expect.any(Function),
      expect.any(Function),
      {
        orderId: "order_1",
        checkoutToken: "chk_order_1",
      },
      expect.objectContaining({ valid: true }),
      expect.objectContaining({
        shippingCharge: 60,
        cityName: "Dhaka",
        zoneName: "Mirpur",
      }),
      undefined,
    );
    expect(mocks.markCheckoutAttemptCommitted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "coa_1",
        claimId: "coac_1",
        orderId: "order_1",
        checkoutToken: "chk_order_1",
      }),
      expect.objectContaining({
        paymentMethod: "cod",
        totalAmount: 100,
        response: expect.objectContaining({
          orderId: "order_1",
          receiptToken: "chk_order_1",
        }),
      }),
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      expect.anything(),
      { orderIds: ["order_1"] },
      expect.objectContaining({
        env: expect.objectContaining({ CACHE: kv }),
        executionCtx,
      }),
    );
  });

  it("replays a committed checkout attempt despite later policy and rate-limit changes", async () => {
    mocks.resolveExistingCheckoutAttempt.mockResolvedValue({
      status: "replay",
      response: {
        checkoutToken: "chk_replay",
        receiptToken: "chk_replay",
        orderId: "order_replay",
        paymentMethod: "cod",
        totalAmount: 100,
        message: "Order created",
      },
    });
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp({
      guestCheckoutEnabled: false,
      checkoutMode: "gateways_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { orderId: string; receiptToken: string } };
    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      orderId: "order_replay",
      receiptToken: "chk_replay",
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptCommitted).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns a pollable processing response for an active duplicate despite later policy changes", async () => {
    mocks.resolveExistingCheckoutAttempt.mockResolvedValue({
      status: "processing",
      orderId: "order_processing",
      checkoutToken: "chk_processing",
    });
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { checkoutToken: string; orderId: string; status: string } };
    expect(response.status).toBe(202);
    expect(json.data).toEqual({
      checkoutToken: "chk_processing",
      orderId: "order_processing",
      status: "processing",
      message: "Order creation is already processing.",
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("still honors a replay won after the read-only precheck race", async () => {
    mocks.claimCheckoutAttempt.mockResolvedValue({
      status: "replay",
      response: {
        checkoutToken: "chk_race_replay",
        receiptToken: "chk_race_replay",
        orderId: "order_race_replay",
        paymentMethod: "cod",
        totalAmount: 100,
        message: "Order created",
      },
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { orderId: string; receiptToken: string } };
    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      orderId: "order_race_replay",
      receiptToken: "chk_race_replay",
    });
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.claimCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("still honors an active duplicate won after the read-only precheck race", async () => {
    mocks.claimCheckoutAttempt.mockResolvedValue({
      status: "processing",
      orderId: "order_race_processing",
      checkoutToken: "chk_race_processing",
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { checkoutToken: string; orderId: string; status: string } };
    expect(response.status).toBe(202);
    expect(json.data).toEqual({
      checkoutToken: "chk_race_processing",
      orderId: "order_race_processing",
      status: "processing",
      message: "Order creation is already processing.",
    });
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.claimCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects changed checkout details before policy, rate limiting, or claim creation", async () => {
    mocks.resolveExistingCheckoutAttempt.mockRejectedValue(
      new ConflictError("This checkout request was already used for different checkout details. Please refresh checkout and try again."),
    );
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(409);
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale cart items before policy, rate limiting, or checkout attempt claim", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: false,
      issues: [
        {
          index: 0,
          productId: "product_1",
          variantId: "variant_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "The price for Queue Product changed. Please review the updated cart total.",
          productName: "Queue Product",
          variantLabel: null,
          requestedQuantity: 1,
          submittedPrice: 100,
          currentPrice: 120,
        },
      ],
      items: [],
      subtotal: 0,
      hasFreeDeliveryProduct: false,
    });
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Some items in your cart need attention.",
        details: {
          itemIssues: [
            {
              code: "PRICE_CHANGED",
              message: "The price for Queue Product changed. Please review the updated cart total.",
              currentPrice: 120,
            },
          ],
        },
      },
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).not.toHaveBeenCalled();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale delivery choices before policy, rate limiting, or checkout attempt claim", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Selected zone is no longer available for the chosen city.",
      },
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledWith(
      expect.anything(),
      {
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: undefined,
      },
      expect.objectContaining({ valid: true }),
    );
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("keeps a committed order successful when product availability cache invalidation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.createStorefrontOrder.mockResolvedValue({
        checkoutToken: "chk_order_cache_failure",
        orderId: "order_cache_failure",
        paymentMethod: "cod",
        totalAmount: 100,
        commitPayload: { orderData: { id: "order_cache_failure" } },
      });
      mocks.invalidateProductAvailabilityCaches.mockRejectedValue(new Error("cache unavailable"));
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validOrderBody),
        },
        { CACHE: kv } as never,
      );

      const responseText = await response.clone().text();
      expect(response.status, responseText).toBe(201);
      expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
      expect(mocks.runStorefrontOrderPostCommitSideEffects).toHaveBeenCalledOnce();
      expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
        expect.anything(),
        { orderIds: ["order_cache_failure"] },
        expect.any(Object),
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[Orders] Failed to invalidate product availability caches after order commit:",
        expect.objectContaining({ orderId: "order_cache_failure" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("marks checkout failed if synchronous order commit fails after KV state is created", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_2",
      orderId: "order_2",
      paymentMethod: "cod",
      totalAmount: 100,
      commitPayload: { orderData: { id: "order_2" } },
    });
    const { app, kv, calls } = createTestApp();
    mocks.commitStorefrontOrderPayload.mockImplementation(async () => {
      calls.push("commit");
      throw new Error("commit unavailable");
    });
    mocks.runStorefrontOrderPostCommitSideEffects.mockImplementation(async () => {
      calls.push("side-effects");
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(500);
    expect(calls).toEqual([
      "commit",
      "kv:checkout_status:chk_order_2",
    ]);
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "coa_1", claimId: "coac_1" }),
      expect.any(Error),
    );
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe("checkout_status:chk_order_2");
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_2",
    });
  });

  it("surfaces discount commit validation failures in checkout status and response body", async () => {
    const discountError = new ValidationError("Discount code has reached its usage limit");
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_discount_limit",
      orderId: "order_discount_limit",
      paymentMethod: "cod",
      totalAmount: 100,
      commitPayload: { orderData: { id: "order_discount_limit" } },
    });
    const { app, kv } = createTestApp();
    mocks.commitStorefrontOrderPayload.mockRejectedValue(discountError);

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Discount code has reached its usage limit",
      },
    });
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "coa_1", claimId: "coac_1" }),
      discountError,
    );
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe("checkout_status:chk_order_discount_limit");
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_discount_limit",
      error: "Discount code has reached its usage limit",
    });
  });

  it("rejects phones outside the configured include countries before payment settings, rate limits, or claims", async () => {
    const { app, kv } = createTestApp({
      allowedCountries: ["BD"],
      allowedCountriesMode: "include",
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          customerPhone: "+14155552671",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Phone numbers from US are not accepted",
      },
    });
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects phones listed in configured exclude countries before payment settings, rate limits, or claims", async () => {
    const { app, kv } = createTestApp({
      allowedCountries: ["BD"],
      allowedCountriesMode: "exclude",
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Phone numbers from BD are not accepted",
      },
    });
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects guest checkout before rate limiting or order creation when merchant disables guests", async () => {
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("allows checkout when guests are disabled but a valid customer session is forwarded", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_1",
      email: "",
      name: "Queue Customer",
      phone: "+8801712345678",
      customerId: "customer_1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_3",
      orderId: "order_3",
      paymentMethod: "cod",
      totalAmount: 100,
      commitPayload: { orderData: { id: "order_3" } },
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_1",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_1", undefined);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
  });

  it("rejects signed-in checkout with a mismatched phone even when guest checkout is enabled", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_guest_enabled_mismatch",
      email: "buyer@example.com",
      name: "Signed In Buyer",
      phone: "+8801812345678",
      customerId: "customer_signed_in",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_guest_enabled_mismatch",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Checkout phone must match the signed-in customer phone.",
      },
    });
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_guest_enabled_mismatch", undefined);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale customer sessions with a recoverable code when guest checkout is enabled", async () => {
    mocks.getCustomerBySession.mockResolvedValue(null);
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "expired_session",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "CUSTOMER_SESSION_STALE",
        message: "Your session expired. Please sign in again or continue as a guest.",
      },
    });
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "expired_session", undefined);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("binds signed-in checkout to the session customer when guest checkout is enabled", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_guest_enabled_match",
      email: "buyer@example.com",
      name: "Signed In Buyer",
      phone: "+8801712345678",
      customerId: "customer_signed_in",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_session_owner",
      orderId: "order_session_owner",
      paymentMethod: "cod",
      totalAmount: 100,
      commitPayload: { orderData: { id: "order_session_owner" } },
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_guest_enabled_match",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_guest_enabled_match", undefined);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: "+8801712345678" }),
      expect.any(String),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        orderId: "order_1",
        checkoutToken: "chk_order_1",
      }),
      expect.objectContaining({ valid: true }),
      expect.objectContaining({ cityName: "Dhaka", zoneName: "Mirpur" }),
      {
        customerId: "customer_signed_in",
        source: "authenticated",
      },
    );
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("rejects authenticated checkout if the forwarded session phone differs from order phone", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_2",
      email: "",
      name: "Different Customer",
      phone: "+8801812345678",
      customerId: "customer_2",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_2",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("rejects authenticated checkout if the customer session has no phone proof", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_3",
      email: "buyer@example.com",
      name: "Email Only Customer",
      customerId: "customer_3",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_3",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects COD order creation when checkout mode is gateways only", async () => {
    const { app, kv } = createTestApp({ checkoutMode: "gateways_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects online order creation when checkout mode is fast COD only", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    const { app, kv } = createTestApp({ checkoutMode: "guest_cod_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "stripe" }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects a payment method that is not in the fresh active method allowlist", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(503);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rate limits a new checkout before claim creation or order writes", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).not.toHaveBeenCalled();
  });

  it("rejects COD before commit when partial payment requires an online deposit", async () => {
    const { app, kv } = createTestApp({
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects empty carts and non-integer quantities at the API boundary", async () => {
    const { app, kv } = createTestApp();

    const emptyCart = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, items: [] }),
      },
      { CACHE: kv } as never,
    );
    const fractionalQuantity = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          items: [{ ...validOrderBody.items[0], quantity: 1.5 }],
        }),
      },
      { CACHE: kv } as never,
    );
    const excessiveQuantity = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          items: [{ ...validOrderBody.items[0], quantity: 100 }],
        }),
      },
      { CACHE: kv } as never,
    );

    expect(emptyCart.status).toBe(400);
    expect(fractionalQuantity.status).toBe(400);
    expect(excessiveQuantity.status).toBe(400);
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("does not write checkout status or receipt proof when location validation fails", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Selected zone is no longer available for the chosen city.",
      },
    });
    expect(kv.put).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
  });

  it("does not write checkout status or receipt proof when the cart product is unavailable", async () => {
    const unavailableError = new NotFoundError("Product product_1 not found or is inactive.");
    mocks.createStorefrontOrder.mockRejectedValue(unavailableError);
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Product product_1 not found or is inactive.",
      },
    });
    expect(kv.put).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(mocks.markCheckoutAttemptFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "coa_1", claimId: "coac_1" }),
      unavailableError,
    );
  });
});
