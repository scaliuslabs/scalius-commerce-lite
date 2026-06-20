import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "../utils/api-error";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  commitStorefrontOrderPayload: vi.fn(),
  runStorefrontOrderPostCommitSideEffects: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
  getCustomerBySession: vi.fn(),
  getActivePaymentMethods: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", () => ({
  createStorefrontOrder: mocks.createStorefrontOrder,
  commitStorefrontOrderPayload: mocks.commitStorefrontOrderPayload,
  runStorefrontOrderPostCommitSideEffects: mocks.runStorefrontOrderPostCommitSideEffects,
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
  mocks.commitStorefrontOrderPayload.mockResolvedValue(undefined);
  mocks.runStorefrontOrderPostCommitSideEffects.mockResolvedValue(undefined);
});

const validOrderBody = {
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
} = {}) {
  const calls: string[] = [];
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string) => {
      calls.push(`kv:${key}`);
    }),
  };
  const queue = {
    send: vi.fn(async () => {
      calls.push("queue:send");
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

  return { app, db, kv, queue, calls };
}

describe("create order commit/KV ordering", () => {
  it("writes checkout and receipt KV before synchronously committing the order", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      queuePayload: { type: "order.ingest", orderData: { id: "order_1" } },
    });
    const { app, kv, queue, calls } = createTestApp();
    mocks.commitStorefrontOrderPayload.mockImplementation(async () => {
      calls.push("commit");
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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(calls).toEqual([
      "kv:checkout_status:chk_order_1",
      "kv:order_receipt:chk_order_1",
      "commit",
      "side-effects",
    ]);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("marks checkout failed if synchronous order commit fails after KV state is created", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_2",
      orderId: "order_2",
      paymentMethod: "cod",
      totalAmount: 100,
      queuePayload: { type: "order.ingest", orderData: { id: "order_2" } },
    });
    const { app, kv, queue, calls } = createTestApp();
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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(response.status).toBe(500);
    expect(calls).toEqual([
      "kv:checkout_status:chk_order_2",
      "kv:order_receipt:chk_order_2",
      "commit",
      "kv:checkout_status:chk_order_2",
    ]);
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe("checkout_status:chk_order_2");
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_2",
    });
  });

  it("rejects guest checkout before rate limiting or order creation when merchant disables guests", async () => {
    const { app, kv, queue } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(response.status).toBe(401);
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
      queuePayload: { type: "order.ingest", orderData: { id: "order_3" } },
    });
    const { app, kv, queue } = createTestApp({ guestCheckoutEnabled: false });

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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(kv, "session_1");
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
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
    const { app, kv, queue } = createTestApp({ guestCheckoutEnabled: false });

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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
    const { app, kv, queue } = createTestApp({ guestCheckoutEnabled: false });

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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects COD order creation when checkout mode is gateways only", async () => {
    const { app, kv, queue } = createTestApp({ checkoutMode: "gateways_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
    const { app, kv, queue } = createTestApp({ checkoutMode: "guest_cod_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "stripe" }),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
    const { app, kv, queue } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(response.status).toBe(503);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects COD before commit when partial payment requires an online deposit", async () => {
    const { app, kv, queue } = createTestApp({
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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects empty carts and non-integer quantities at the API boundary", async () => {
    const { app, kv, queue } = createTestApp();

    const emptyCart = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, items: [] }),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
    );

    expect(emptyCart.status).toBe(400);
    expect(fractionalQuantity.status).toBe(400);
    expect(excessiveQuantity.status).toBe(400);
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("does not write checkout status or receipt proof when location validation fails", async () => {
    mocks.createStorefrontOrder.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    const { app, kv, queue } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv, ORDER_INGEST_QUEUE: queue } as never,
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
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
  });
});
