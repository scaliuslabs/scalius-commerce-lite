import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  verifyDeliveryWebhook: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventProcessed: vi.fn(),
  markWebhookEventFailed: vi.fn(),
  updateOrderStatusFromShipment: vi.fn(),
  invalidateProductAvailabilityCaches: vi.fn(),
  enqueueOrderStatusChangeNotification: vi.fn(),
}));

vi.mock("../../middleware/webhook-auth", () => ({
  verifyDeliveryWebhook: mocks.verifyDeliveryWebhook,
}));

vi.mock("../../utils/webhook-idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/webhook-idempotency")>();
  return {
    ...actual,
    claimWebhookEvent: mocks.claimWebhookEvent,
    markWebhookEventProcessed: mocks.markWebhookEventProcessed,
    markWebhookEventFailed: mocks.markWebhookEventFailed,
  };
});

vi.mock("@scalius/core/modules/delivery/tracking", () => ({
  updateOrderStatusFromShipment: mocks.updateOrderStatusFromShipment,
}));

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", () => ({
  enqueueOrderStatusChangeNotification: mocks.enqueueOrderStatusChangeNotification,
}));

import { buildSteadfastWebhookDedupKey, steadfastWebhookRoutes } from "./steadfast";

function createDbMock(shipment: Record<string, unknown> | null) {
  const updateSet = vi.fn((values: Record<string, unknown>) => ({
    where: vi.fn(() => Promise.resolve(values)),
  }));
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => shipment,
              };
            },
          };
        },
      };
    },
    update: vi.fn(() => ({
      set: updateSet,
    })),
  };
  return { db, updateSet };
}

function createApp(db: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: { db: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", steadfastWebhookRoutes);
  return app;
}

async function postWebhook(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request(
    "/",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    {} as Env,
  );
}

describe("Steadfast webhook idempotency keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.verifyDeliveryWebhook.mockResolvedValue({ verified: true, credentials: {} });
    mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
    mocks.updateOrderStatusFromShipment.mockResolvedValue(null);
    mocks.enqueueOrderStatusChangeNotification.mockResolvedValue(null);
  });

  it("includes delivery status so later status changes are not deduplicated", () => {
    const pending = buildSteadfastWebhookDedupKey({
      notification_type: "delivery_status",
      consignment_id: 123,
      status: "pending",
    });
    const delivered = buildSteadfastWebhookDedupKey({
      notification_type: "delivery_status",
      consignment_id: 123,
      status: "delivered",
    });

    expect(pending).toBe("delivery_wh:steadfast:123:delivery_status:pending");
    expect(delivered).toBe("delivery_wh:steadfast:123:delivery_status:delivered");
    expect(pending).not.toBe(delivered);
  });

  it("includes tracking update identity so later tracking messages are not collapsed", () => {
    const first = buildSteadfastWebhookDedupKey({
      notification_type: "tracking_update",
      invoice: "INV-1",
      tracking_message: "Parcel picked",
      updated_at: "2026-06-13T01:00:00Z",
    });
    const second = buildSteadfastWebhookDedupKey({
      notification_type: "tracking_update",
      invoice: "INV-1",
      tracking_message: "At hub",
      updated_at: "2026-06-13T02:00:00Z",
    });

    expect(first).toBe("delivery_wh:steadfast:inv-1:tracking_update:2026-06-13t01:00:00z");
    expect(second).toBe("delivery_wh:steadfast:inv-1:tracking_update:2026-06-13t02:00:00z");
    expect(first).not.toBe(second);
  });

  it("claims a durable delivery-status event before updating the shipment", async () => {
    const { db, updateSet } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      externalId: "123",
      trackingId: "INV-1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 123,
      invoice: "INV-1",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: "steadfast:delivery_status:delivery_wh:steadfast:123:delivery_status:delivered",
        provider: "steadfast",
        eventType: "delivery_status",
        orderId: "order_1",
        status: "processing",
      }),
    );
    expect(mocks.claimWebhookEvent.mock.invocationCallOrder[0]!)
      .toBeLessThan(updateSet.mock.invocationCallOrder[0]!);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "delivered",
      rawStatus: "delivered",
    }));
    expect(mocks.markWebhookEventProcessed).toHaveBeenCalledWith(
      db,
      "steadfast:delivery_status:delivery_wh:steadfast:123:delivery_status:delivered",
      expect.objectContaining({ rawStatus: "delivered", normalizedStatus: "delivered" }),
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      db,
      { orderIds: ["order_1"] },
      expect.anything(),
    );
    expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
      db,
      queue: undefined,
      statusChange: null,
      trackingId: "INV-1",
      source: "steadfast-webhook",
    });
  });

  it("enqueues a customer notification after a real order status change", async () => {
    const statusChange = {
      orderId: "order_1",
      previousStatus: "shipped",
      newStatus: "delivered",
    };
    mocks.updateOrderStatusFromShipment.mockResolvedValue(statusChange);
    const queue = { send: vi.fn() };
    const { db } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      externalId: "123",
      trackingId: "INV-1",
      status: "in_transit",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await app.request(
      "/",
      {
        method: "POST",
        body: JSON.stringify({
          notification_type: "delivery_status",
          consignment_id: 123,
          invoice: "INV-1",
          status: "delivered",
        }),
      },
      { ORDER_NOTIFICATIONS_QUEUE: queue } as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
      db,
      queue,
      statusChange,
      trackingId: "INV-1",
      source: "steadfast-webhook",
    });
  });

  it("skips duplicate durable delivery-status events before shipment updates", async () => {
    mocks.claimWebhookEvent.mockResolvedValue({
      claimed: false,
      existing: { status: "processed" },
    });
    const { db, updateSet } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      externalId: "123",
      trackingId: "INV-1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 123,
      invoice: "INV-1",
      status: "delivered",
    });
    const body = await response.json() as { deduplicated?: boolean };

    expect(response.status).toBe(200);
    expect(body.deduplicated).toBe(true);
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.updateOrderStatusFromShipment).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).not.toHaveBeenCalled();
  });
});
