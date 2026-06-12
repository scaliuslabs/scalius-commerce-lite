import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@scalius/core/modules/orders", () => ({
  createStorefrontOrder: mocks.createStorefrontOrder,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  getClientIp: mocks.getClientIp,
}));

import { orderRoutes } from "./orders";

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

function createTestApp(options: { queueSend?: () => Promise<void> } = {}) {
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
      await options.queueSend?.();
    }),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, kv, queue, calls };
}

describe("create order queue/KV ordering", () => {
  it("writes checkout and receipt KV before sending the order ingest queue message", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      queuePayload: { type: "order.ingest", orderData: { id: "order_1" } },
    });
    const { app, kv, queue, calls } = createTestApp();

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
    expect(response.status, responseText).toBe(202);
    expect(calls).toEqual([
      "kv:checkout_status:chk_order_1",
      "kv:order_receipt:chk_order_1",
      "queue:send",
    ]);
    expect(queue.send).toHaveBeenCalledWith({ type: "order.ingest", orderData: { id: "order_1" } });
  });

  it("marks checkout failed if queue send fails after KV state is created", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_2",
      orderId: "order_2",
      paymentMethod: "cod",
      totalAmount: 100,
      queuePayload: { type: "order.ingest", orderData: { id: "order_2" } },
    });
    const { app, kv, queue, calls } = createTestApp({
      queueSend: async () => {
        throw new Error("queue unavailable");
      },
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
      "queue:send",
      "kv:checkout_status:chk_order_2",
    ]);
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe("checkout_status:chk_order_2");
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_2",
    });
  });
});
