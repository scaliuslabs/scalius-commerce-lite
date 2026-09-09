import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import { checkShipmentStatus } from "@scalius/core/modules/delivery/delivery.service";

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

function sqliteD1Statement(sqlite: DatabaseSync, query: string, values: SQLInputValue[] = []) {
  const execute = () => ({
    results: sqlite.prepare(query).all(...values) as Record<string, SQLOutputValue>[],
    success: true as const,
    meta: {},
  });
  return {
    query,
    bind: (...nextValues: SQLInputValue[]) => sqliteD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column?: string) => {
      const row = sqlite.prepare(query).all(...values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createDbMock(
  shipment: Record<string, unknown> | null,
  fallbackShipments: Record<string, unknown>[] = [],
  race?: { bindingLost: boolean; rebound: Record<string, unknown> | null },
) {
  const whereCalls: unknown[] = [];
  let selectCount = 0;
  const returning = vi.fn(async () => race?.bindingLost
    ? []
    : [{ id: String(shipment?.id ?? fallbackShipments[0]?.id ?? "shipment_1") }]);
  const updateWhere = vi.fn(() => ({
    returning,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  }));
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({
    where: updateWhere,
  }));
  const db = {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              whereCalls.push(condition);
              const current = selectCount === 0
                ? shipment
                : selectCount === 1
                  ? fallbackShipments
                  : race?.rebound ?? null;
              selectCount++;
              return {
                get: async () => current,
                limit: async () => current,
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
  return { db, updateSet, updateWhere, returning, whereCalls };
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
    mocks.verifyDeliveryWebhook.mockResolvedValue({
      verified: true,
      providerId: "provider_steadfast",
      credentials: {},
    });
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
      trackingId: "TRACK-1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 123,
      invoice: "order_1",
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
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
      db,
      queue: undefined,
      statusChange: null,
      trackingId: "TRACK-1",
      source: "steadfast-webhook",
    });
  });

  it("scopes delivery-status shipment lookup to the verified active provider", async () => {
    const { whereCalls, db } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      providerId: "provider_steadfast",
      providerType: "steadfast",
      externalId: "123",
      trackingId: "TRACK-1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 123,
      invoice: "order_1",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    const dialect = new SQLiteSyncDialect();
    const lookupQuery = dialect.sqlToQuery(whereCalls[0] as never);
    expect(lookupQuery.sql).toContain('"delivery_shipments"."external_id" = ?');
    expect(lookupQuery.sql).toContain('"delivery_shipments"."provider_type" = ?');
    expect(lookupQuery.sql).toContain('"delivery_shipments"."provider_id" = ?');
    expect(lookupQuery.params).toEqual(["123", "steadfast", "provider_steadfast"]);
  });

  it("binds a confirmed recovered shipment by its original invoice", async () => {
    const recovered = {
      id: "shipment_recovered",
      orderId: "INV-RECOVERED",
      providerId: "provider_steadfast",
      providerType: "steadfast",
      externalId: null,
      trackingId: null,
      status: "pending",
      metadata: JSON.stringify({
        unknownOutcomeResolution: {
          method: "provider_lookup",
          outcome: "confirmed_existing",
        },
      }),
    };
    const { db, updateSet, whereCalls } = createDbMock(null, [recovered]);
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 924,
      invoice: "INV-RECOVERED",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({ externalId: "924" }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: "delivered",
      rawStatus: "delivered",
    }));
    const dialect = new SQLiteSyncDialect();
    const recoveryLookup = dialect.sqlToQuery(whereCalls[1] as never);
    expect(recoveryLookup.sql).toContain('"delivery_shipments"."order_id" = ?');
    expect(recoveryLookup.sql).toContain("unknownOutcomeResolution.outcome");
    expect(recoveryLookup.params).toEqual([
      "INV-RECOVERED",
      "steadfast",
      "provider_steadfast",
    ]);
  });

  it("rejects a consignment whose invoice belongs to another order", async () => {
    const { db, updateSet } = createDbMock({
      id: "shipment_1",
      orderId: "INV-ORIGINAL",
      externalId: "924",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 924,
      invoice: "INV-OTHER",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.updateOrderStatusFromShipment).not.toHaveBeenCalled();
  });

  it("does not bind an invoice when recovered shipment history is ambiguous", async () => {
    const evidence = JSON.stringify({
      unknownOutcomeResolution: { outcome: "confirmed_existing" },
    });
    const { db, updateSet } = createDbMock(null, [
      { id: "shipment_old", orderId: "INV-1", externalId: null, metadata: evidence },
      { id: "shipment_current", orderId: "INV-1", externalId: null, metadata: evidence },
    ]);
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 924,
      invoice: "INV-1",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.updateOrderStatusFromShipment).not.toHaveBeenCalled();
  });

  it("continues when a concurrent callback bound the same consignment", async () => {
    const recovered = {
      id: "shipment_recovered",
      orderId: "INV-RECOVERED",
      providerId: "provider_steadfast",
      providerType: "steadfast",
      externalId: null,
      trackingId: null,
      status: "pending",
      metadata: JSON.stringify({
        unknownOutcomeResolution: { outcome: "confirmed_existing" },
      }),
    };
    const { db, updateSet } = createDbMock(null, [recovered], {
      bindingLost: true,
      rebound: { ...recovered, externalId: "924" },
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 924,
      invoice: "INV-RECOVERED",
      status: "delivered",
    });

    expect(response.status).toBe(200);
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "delivered" }));
    expect(mocks.updateOrderStatusFromShipment).toHaveBeenCalledWith(
      db,
      "shipment_recovered",
      "delivered",
    );
  });

  it("persists the recovered consignment for subsequent provider polling", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      const migrations = new URL("../../../../../packages/database/migrations/", import.meta.url);
      for (const name of readdirSync(migrations).filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort()) {
        sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
      }
      const binding = {
        prepare: (query: string) => sqliteD1Statement(sqlite, query),
        async batch(statements: ReturnType<typeof sqliteD1Statement>[]) {
          return statements.map((statement) => statement.execute());
        },
      };
      const db = drizzle(binding as never, { schema });
      await db.insert(schema.deliveryProviders).values({
        id: "provider_steadfast",
        name: "Steadfast",
        type: "steadfast",
        isActive: true,
        credentials: JSON.stringify({
          baseUrl: "https://courier.invalid",
          apiKey: "synthetic-api-924",
          secretKey: "synthetic-secret-924",
        }),
        config: "{}",
      });
      await db.insert(schema.orders).values({
        id: "INV-RECOVERED",
        customerName: "Synthetic buyer",
        customerPhone: "+8801712345678",
        shippingAddress: "Synthetic address",
        city: "Synthetic city",
        zone: "Synthetic zone",
        totalAmount: 100,
        shippingCharge: 0,
        balanceDue: 100,
        status: "shipped",
        fulfillmentStatus: "complete",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
      });
      await db.insert(schema.deliveryShipments).values({
        id: "shipment_recovered",
        orderId: "INV-RECOVERED",
        providerId: "provider_steadfast",
        providerType: "steadfast",
        status: "pending",
        metadata: JSON.stringify({
          unknownOutcomeResolution: {
            method: "provider_lookup",
            outcome: "confirmed_existing",
            evidenceSource: "provider_api_invoice_lookup",
          },
        }),
      });
      const app = createApp(db);

      const response = await postWebhook(app, {
        notification_type: "delivery_status",
        consignment_id: 924,
        invoice: "INV-RECOVERED",
        status: "pending",
      });
      expect(response.status).toBe(200);
      expect(sqlite.prepare("SELECT external_id FROM delivery_shipments WHERE id = ?").get("shipment_recovered"))
        .toEqual({ external_id: "924" });

      let requestedUrl = "";
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        requestedUrl = url;
        return Response.json({ status: 200, delivery_status: "in_review" });
      }));
      await expect(checkShipmentStatus(db as never, "shipment_recovered")).resolves.toMatchObject({
        externalId: "924",
        status: "pending",
      });
      expect(requestedUrl).toBe("https://courier.invalid/status_by_cid/924");
    } finally {
      vi.unstubAllGlobals();
      sqlite.close();
    }
  });

  it("enqueues a customer notification after a real order status change", async () => {
    const statusChange = {
      orderId: "order_1",
      previousStatus: "shipped",
      newStatus: "delivered",
    };
    mocks.updateOrderStatusFromShipment.mockResolvedValue({
      statusChange,
      availabilityTransitionVariantIds: ["variant_1"],
    });
    const queue = { send: vi.fn() };
    const { db } = createDbMock({
      id: "shipment_1",
      orderId: "order_1",
      externalId: "123",
      trackingId: "TRACK-1",
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
          invoice: "order_1",
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
      trackingId: "TRACK-1",
      source: "steadfast-webhook",
    });
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      db,
      { variantIds: ["variant_1"] },
      expect.anything(),
    );
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
      trackingId: "TRACK-1",
      status: "pending",
      metadata: "{}",
    });
    const app = createApp(db);

    const response = await postWebhook(app, {
      notification_type: "delivery_status",
      consignment_id: 123,
      invoice: "order_1",
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
