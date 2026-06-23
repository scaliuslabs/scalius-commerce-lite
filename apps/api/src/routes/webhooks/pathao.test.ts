import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

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

import { pathaoWebhookRoutes } from "./pathao";

function createDbMock(shipment: Record<string, unknown> | null) {
  const whereCalls: unknown[] = [];
  const updateSet = vi.fn((values: Record<string, unknown>) => ({
    where: vi.fn(() => Promise.resolve(values)),
  }));
  const db = {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              whereCalls.push(condition);
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
  return { db, updateSet, whereCalls };
}

function createApp(db: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: { db: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", pathaoWebhookRoutes);
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

describe("Pathao webhook provider authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.verifyDeliveryWebhook.mockResolvedValue({
      verified: true,
      providerId: "provider_pathao",
      credentials: { webhookSecret: "merchant-secret" },
    });
    mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
    mocks.updateOrderStatusFromShipment.mockResolvedValue(null);
    mocks.enqueueOrderStatusChangeNotification.mockResolvedValue(null);
  });

  it("scopes shipment lookup to the verified active provider", async () => {
    const { db, whereCalls, updateSet } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      providerId: "provider_pathao",
      providerType: "pathao",
      externalId: "consignment_123",
      trackingId: "track_1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      event: "order.delivered",
      consignment_id: "consignment_123",
    });

    expect(response.status).toBe(202);
    const dialect = new SQLiteSyncDialect();
    const lookupQuery = dialect.sqlToQuery(whereCalls[0] as never);
    expect(lookupQuery.sql).toContain('"delivery_shipments"."external_id" = ?');
    expect(lookupQuery.sql).toContain('"delivery_shipments"."provider_type" = ?');
    expect(lookupQuery.sql).toContain('"delivery_shipments"."provider_id" = ?');
    expect(lookupQuery.params).toEqual(["consignment_123", "pathao", "provider_pathao"]);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "delivered",
      rawStatus: "order.delivered",
    }));
  });
});
