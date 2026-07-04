import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "./orders";

const orderSupportMocks = vi.hoisted(() => ({
  createReceiptOrderSupportRequest: vi.fn(),
  getReceiptOrderSupportRequestStateForOrder: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  enqueueOrderSupportRequestNotificationForOrder: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
  return {
    ...actual,
    createReceiptOrderSupportRequest: orderSupportMocks.createReceiptOrderSupportRequest,
    getReceiptOrderSupportRequestStateForOrder: orderSupportMocks.getReceiptOrderSupportRequestStateForOrder,
  };
});

vi.mock("../utils/order-notification-queue", () => notificationMocks);

const orderRow = {
  id: "order_1",
  customerId: "cust_internal",
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
  fulfillmentStatus: "pending",
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

const supportRequest = {
  id: "osr_1",
  orderId: "order_1",
  customerId: null,
  type: "cancel_pre_shipment",
  status: "submitted",
  active: true,
  severity: "info",
  label: "Cancellation request submitted",
  actionLabel: "Request cancellation",
  reason: "Please cancel before shipment",
  message: null,
  submittedAt: "2026-06-30T00:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

const supportRequestActions = [
  {
    type: "cancel_pre_shipment",
    label: "Request cancellation",
    description: "Ask the merchant to review this order before it ships.",
    eligible: false,
    disabledReason: "Cancellation request is already open for this order.",
  },
  {
    type: "return",
    label: "Request return",
    description: "Ask the merchant to review a return for this order.",
    eligible: false,
    disabledReason: "Cancellation request is already open for this order.",
  },
  {
    type: "refund",
    label: "Request refund",
    description: "Ask the merchant to review a payment refund.",
    eligible: false,
    disabledReason: "Cancellation request is already open for this order.",
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
  beforeEach(() => {
    orderSupportMocks.getReceiptOrderSupportRequestStateForOrder.mockResolvedValue({
      supportRequests: [supportRequest],
      supportRequestActions,
    });
    orderSupportMocks.createReceiptOrderSupportRequest.mockResolvedValue({
      request: supportRequest,
      supportRequests: [supportRequest],
      supportRequestActions,
    });
    notificationMocks.enqueueOrderSupportRequestNotificationForOrder.mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

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
    expect(document.paths).toHaveProperty("/receipt/{id}/support-requests");
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
      supportRequests: [supportRequest],
      supportRequestActions,
    });
    expect(body.data?.order).not.toHaveProperty("customerPhone");
    expect(body.data?.order).not.toHaveProperty("customerEmail");
    expect(body.data?.order).not.toHaveProperty("customerId");
    expect(body.data?.order).not.toHaveProperty("fulfillmentStatus");
    expect(body.data?.order).not.toHaveProperty("paymentIntentId");
    expect(body.data?.order).not.toHaveProperty("shipments");
    expect(body.data?.order).not.toHaveProperty("deliveryProviders");
    expect(orderSupportMocks.getReceiptOrderSupportRequestStateForOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "order_1",
        customerId: "cust_internal",
        status: "pending",
        paymentStatus: "partial",
        fulfillmentStatus: "pending",
        paidAmount: 100,
      }),
    );
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
    expect(body.data?.order?.supportRequests).toEqual([supportRequest]);
    expect(kv.get).toHaveBeenCalledWith("order_receipt:chk_valid");
    expect(kv.put).toHaveBeenCalledWith(
      "order_receipt:chk_valid",
      JSON.stringify({ orderId: "order_1" }),
      { expirationTtl: 60 * 60 * 24 * 7 },
    );
  });

  it("does not repair receipt KV for a still-processing checkout attempt", async () => {
    const { app, kv } = createTestApp({
      tokenOrderId: null,
      attemptRow: { orderId: "order_1", status: "processing" },
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
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects receipt support requests when the token does not match", async () => {
    const { app, db, kv } = createTestApp({ tokenOrderId: "other_order" });

    const response = await app.request(
      "/api/v1/orders/receipt/order_1/support-requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "chk_wrong",
          type: "cancel_pre_shipment",
          reason: "Please cancel before shipment",
        }),
      },
      { CACHE: kv, ORDER_NOTIFICATIONS_QUEUE: { send: vi.fn() } } as never,
    );

    expect(response.status).toBe(404);
    expect(kv.get).toHaveBeenCalledWith("order_receipt:chk_wrong");
    expect(db.select).not.toHaveBeenCalled();
    expect(orderSupportMocks.createReceiptOrderSupportRequest).not.toHaveBeenCalled();
    expect(notificationMocks.enqueueOrderSupportRequestNotificationForOrder).not.toHaveBeenCalled();
  });

  it("creates receipt support requests with safe notification metadata", async () => {
    const { app, db, kv } = createTestApp({ tokenOrderId: "order_1" });
    const queue = { send: vi.fn() };

    const response = await app.request(
      "/api/v1/orders/receipt/order_1/support-requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "chk_valid",
          type: "cancel_pre_shipment",
          reason: "Please cancel before shipment",
          message: "Ordered by mistake.",
        }),
      },
      { CACHE: kv, ORDER_NOTIFICATIONS_QUEUE: queue } as never,
    );
    const body = await response.json() as {
      data?: {
        request?: Record<string, unknown>;
        supportRequests?: unknown[];
        supportRequestActions?: unknown[];
      };
    };

    expect(response.status).toBe(201);
    expect(body.data?.request).toMatchObject({
      id: "osr_1",
      customerId: null,
      type: "cancel_pre_shipment",
      status: "submitted",
    });
    expect(orderSupportMocks.createReceiptOrderSupportRequest).toHaveBeenCalledWith(
      db,
      "order_1",
      {
        type: "cancel_pre_shipment",
        reason: "Please cancel before shipment",
        message: "Ordered by mistake.",
      },
    );
    expect(notificationMocks.enqueueOrderSupportRequestNotificationForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        queue,
        orderId: "order_1",
        requestId: "osr_1",
        notificationType: "support_request_submitted",
        source: "receipt-support-request",
        status: "submitted",
        data: {
          supportRequestType: "cancel_pre_shipment",
          supportRequestTypeLabel: "Cancellation request submitted",
          supportRequestStatus: "submitted",
          supportRequestStatusLabel: "Submitted",
        },
      }),
    );
    const notificationPayload = notificationMocks.enqueueOrderSupportRequestNotificationForOrder.mock.calls[0]?.[0]?.data;
    expect(notificationPayload).not.toHaveProperty("reason");
    expect(notificationPayload).not.toHaveProperty("message");
    expect(notificationPayload).not.toHaveProperty("token");
  });
});
