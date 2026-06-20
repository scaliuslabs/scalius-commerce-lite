import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "./orders";

const orderRow = {
  id: "order_1",
  customerName: "Receipt Customer",
  shippingAddress: "123 Receipt Street",
  totalAmount: 250,
  shippingCharge: 50,
  discountAmount: 10,
  city: "city_1",
  zone: "zone_1",
  area: null,
  cityName: "Dhaka",
  zoneName: "Gulshan",
  areaName: null,
  status: "pending",
  paymentMethod: "sslcommerz",
  paymentStatus: "partial",
  paidAmount: 100,
  balanceDue: 150,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
};

const itemRows = [
  {
    id: "item_1",
    productId: "product_1",
    variantId: null,
    quantity: 2,
    price: 100,
    productName: "Receipt Product",
    productImage: null,
    variantSize: null,
    variantColor: null,
  },
];

function createDbMock(options: {
  attemptRow?: { orderId: string; status: string } | null;
} = {}) {
  let selectCount = 0;
  return {
    select: vi.fn(() => {
      selectCount += 1;
      if (options.attemptRow && selectCount === 1) {
        return {
          from: () => ({
            where: () => ({
              get: async () => options.attemptRow,
            }),
          }),
        };
      }

      if (selectCount === 1) {
        return {
          from: () => ({
            where: () => ({
              get: async () => orderRow,
            }),
          }),
        };
      }

      if (options.attemptRow && selectCount === 2) {
        return {
          from: () => ({
            where: () => ({
              get: async () => orderRow,
            }),
          }),
        };
      }

      const itemQuery = {
        from: () => itemQuery,
        leftJoin: () => itemQuery,
        where: async () => itemRows,
      };
      return itemQuery;
    }),
  };
}

function createTestApp(options: {
  tokenOrderId?: string | null;
  attemptRow?: { orderId: string; status: string } | null;
}) {
  const db = createDbMock({ attemptRow: options.attemptRow });
  const kv = {
    get: vi.fn().mockResolvedValue(
      options.tokenOrderId
        ? JSON.stringify({ orderId: options.tokenOrderId })
        : null,
    ),
    put: vi.fn(async () => undefined),
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

describe("order receipt route", () => {
  it("does not expose raw order details by ID", async () => {
    const { app, db, kv } = createTestApp({ tokenOrderId: "order_1" });

    const response = await app.request(
      "/api/v1/orders/order_1",
      {},
      { CACHE: kv } as never,
    );
    const document = orderRoutes.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Orders", version: "test" },
    });

    expect(response.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(document.paths).not.toHaveProperty("/{id}");
    expect(document.paths).toHaveProperty("/receipt/{id}");
    expect(document.paths).toHaveProperty("/status/{token}");
  });

  it("does not expose a receipt by order ID alone", async () => {
    const { app, db, kv } = createTestApp({ tokenOrderId: "order_1" });

    const response = await app.request(
      "/api/v1/orders/receipt/order_1",
      {},
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(404);
    expect(kv.get).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects a token that does not map to the requested order", async () => {
    const { app, db, kv } = createTestApp({ tokenOrderId: "other_order" });

    const response = await app.request(
      "/api/v1/orders/receipt/order_1?token=chk_wrong",
      {},
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(404);
    expect(kv.get).toHaveBeenCalledWith("order_receipt:chk_wrong");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns a minimal receipt DTO for a valid token", async () => {
    const { app, kv } = createTestApp({ tokenOrderId: "order_1" });

    const response = await app.request(
      "/api/v1/orders/receipt/order_1?token=chk_valid",
      {},
      { CACHE: kv } as never,
    );
    const body = await response.json() as {
      data?: { order?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(body.data?.order).toMatchObject({
      id: "order_1",
      customerName: "Receipt Customer",
      shippingAddress: "123 Receipt Street",
      paymentMethod: "sslcommerz",
      paymentStatus: "partial",
      paidAmount: 100,
      balanceDue: 150,
      items: itemRows,
    });
    expect(body.data?.order).not.toHaveProperty("customerPhone");
    expect(body.data?.order).not.toHaveProperty("customerEmail");
    expect(body.data?.order).not.toHaveProperty("customerId");
    expect(body.data?.order).not.toHaveProperty("paymentIntentId");
    expect(body.data?.order).not.toHaveProperty("shipments");
    expect(body.data?.order).not.toHaveProperty("deliveryProviders");
  });

  it("falls back to D1 checkout attempts and repairs KV when receipt KV is missing", async () => {
    const { app, kv } = createTestApp({
      tokenOrderId: null,
      attemptRow: { orderId: "order_1", status: "committed" },
    });

    const response = await app.request(
      "/api/v1/orders/receipt/order_1?token=chk_valid",
      {},
      { CACHE: kv } as never,
    );
    const body = await response.json() as {
      data?: { order?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(body.data?.order?.id).toBe("order_1");
    expect(kv.get).toHaveBeenCalledWith("order_receipt:chk_valid");
    expect(kv.put).toHaveBeenCalledWith(
      "order_receipt:chk_valid",
      JSON.stringify({ orderId: "order_1" }),
      { expirationTtl: 60 * 60 * 24 * 7 },
    );
  });
});
