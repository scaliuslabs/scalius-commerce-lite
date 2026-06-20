import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  commitStorefrontOrderPayload: vi.fn(),
  runStorefrontOrderPostCommitSideEffects: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
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

import { orderRoutes } from "./orders";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.getClientIp.mockReturnValue("127.0.0.1");
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

function createTestApp() {
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
});
