import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
  bulkShipOrders,
  lookupUnknownOrderShipment,
  reconcileOrderShipment,
  resolveUnknownOrderShipment,
} from "../orders/orders.fulfillment";
import { checkShipmentStatus, deleteShipmentRecord } from "./delivery.service";
import { applyInventoryForStatusChangeWithImpact } from "../inventory/inventory-transitions";
import { getDeliveryProviderSetupFingerprint } from "./provider-readiness";
import { mapProviderStatus } from "./status-mapper";
import { updateOrderStatusFromShipment } from "./tracking";

// Keep the real provider, delivery service, claims and database; inventory is a separate boundary.
vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChangeWithImpact: vi.fn(),
}));
interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  query: string;
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: sqlite.prepare(query).all(...values),
    success: true,
    meta: {},
  });

  return {
    query,
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = sqlite.prepare(query).all(...values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}


type Outcome = "network" | "invalid-json" | "http-502" | "missing-id" | "http-408" | "http-409" | "http-429" | "rejected" | "success";

describe.each(["pathao", "steadfast"] as const)("%s shipment outcome through the persisted fulfillment flow", (providerType) => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let createPosts: number;
  const key = "synthetic-local-fingerprint-key";

  beforeEach(async () => {
    createPosts = 0;
    vi.mocked(applyInventoryForStatusChangeWithImpact).mockReset().mockResolvedValue({
      inventoryAction: "deducted", availabilityTransitionVariantIds: [],
    });
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    sqlite.exec("PRAGMA foreign_keys = ON");
    const binding = {
      prepare: (query: string) => createD1Statement(sqlite, query),
      async batch(statements: SqliteD1Statement[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = drizzle(binding as never, { schema });
    const credentials = providerType === "pathao" ? {
      baseUrl: "https://courier.invalid", clientId: "synthetic-client-924", clientSecret: "synthetic-secret-924",
      username: "synthetic-user-924", password: "synthetic-password-924",
    } : { baseUrl: "https://courier.invalid", apiKey: "synthetic-api-924", secretKey: "synthetic-secret-924" };
    const config = providerType === "pathao"
      ? { storeId: "924", defaultDeliveryType: 48, defaultItemType: 2, defaultItemWeight: 0.5 }
      : { defaultCodAmount: 0 };
    const fingerprint = await getDeliveryProviderSetupFingerprint({ type: providerType, credentials, config }, key);
    const now = new Date();
    await db.insert(schema.deliveryProviders).values({
      id: "provider_local", name: "Synthetic provider", type: providerType, isActive: true,
      credentials: JSON.stringify(credentials), config: JSON.stringify(config),
      lastTestAttemptAt: now, lastTestSuccessAt: now, lastTestSuccessFingerprint: fingerprint,
    });
    await db.insert(schema.deliveryLocations).values([
      { id: "city_local", name: "Synthetic City", type: "city", externalIds: '{"pathao":"1"}', metadata: "{}" },
      { id: "zone_local", name: "Synthetic Zone", type: "zone", parentId: "city_local", externalIds: '{"pathao":"2"}', metadata: "{}" },
    ]);
    await db.insert(schema.products).values({ id: "product_local", name: "Synthetic product", slug: "synthetic-product", price: 100 });
    await db.insert(schema.productVariants).values({ id: "variant_local", productId: "product_local", sku: "SYNTHETIC-924", price: 100, isDefault: true, trackInventory: false });
    await db.insert(schema.orders).values({
      id: "order_local", customerName: "Synthetic buyer", customerPhone: "+8801712345678", shippingAddress: "Synthetic audit address",
      city: "city_local", zone: "zone_local", totalAmount: 160, shippingCharge: 60, balanceDue: 160,
      currencyCode: "BDT", currencyDecimalPlaces: 2, status: "confirmed", paymentMethod: "cod", paymentStatus: "unpaid",
    });
    await db.insert(schema.orderItems).values({ id: "item_local", orderId: "order_local", productId: "product_local", variantId: "variant_local", quantity: 1, price: 100 });
  });
  afterEach(() => { vi.unstubAllGlobals(); sqlite?.close(); });

  function mockProvider(outcome: Outcome, failShipmentWrites = false) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://courier.invalid/aladdin/api/v1/issue-token") {
        return Response.json({ access_token: "synthetic-token", expires_in: 86400 });
      }
      const statusUrl = providerType === "pathao"
        ? "/aladdin/api/v1/orders/confirmed-consignment/info"
        : "/status_by_cid/confirmed-consignment";
      if (url === `https://courier.invalid${statusUrl}` && init?.method === "GET") {
        return Response.json(providerType === "pathao"
          ? { code: 200, data: { order_status: "Delivered" } }
          : { status: 200, delivery_status: "delivered" });
      }
      const createUrl = providerType === "pathao" ? "/aladdin/api/v1/orders" : "/create_order";
      if (url !== `https://courier.invalid${createUrl}` || init?.method !== "POST") {
        throw new Error("Unexpected local test endpoint");
      }
      createPosts++;
      const payload = JSON.parse(String(init.body));
      expect(payload).toMatchObject(providerType === "pathao"
        ? { store_id: 924, merchant_order_id: "order_local", recipient_city: 1, recipient_zone: 2, amount_to_collect: 160, item_quantity: 1 }
        : { invoice: "order_local", cod_amount: 160 });
      if (failShipmentWrites) {
        sqlite.exec("CREATE TRIGGER fail_shipment_write BEFORE UPDATE ON delivery_shipments BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END");
      }
      if (outcome === "network") throw new TypeError("SENSITIVE-UPSTREAM-DETAIL transport failed");
      if (outcome === "invalid-json") return new Response('{"SENSITIVE-UPSTREAM-DETAIL":', { status: 201 });
      if (outcome === "rejected" || outcome.startsWith("http-")) {
        const status = outcome === "rejected" ? 422 : Number(outcome.slice(5));
        return Response.json({ code: status, status, message: "SENSITIVE-UPSTREAM-DETAIL", errors: { "SENSITIVE-UPSTREAM-DETAIL": ["Invalid"] } }, { status });
      }
      const consignmentId = outcome === "missing-id" ? undefined : providerType === "pathao" ? "synthetic-consignment" : 924;
      return Response.json(providerType === "pathao"
        ? { code: 200, message: "Created", data: { consignment_id: consignmentId, order_status: "Pending", delivery_fee: 60 } }
        : { status: 200, message: "Created", consignment: { consignment_id: consignmentId, tracking_code: "synthetic-tracking", status: "pending" } }, { status: 201 });
    }));
  }
  const create = () => bulkShipOrders(db as never, ["order_local"], "provider_local", {}, key);
  const orderState = () => sqlite.prepare("SELECT status, version, inventory_action, shipment_claim_id, shipment_claim_expires_at FROM orders WHERE id='order_local'").get();
  const shipmentRows = () => sqlite.prepare("SELECT id, status, raw_status, external_id, metadata FROM delivery_shipments ORDER BY created_at,id").all();

  it.each(["network", "invalid-json", "http-502", "missing-id", "http-408", "http-409", "http-429"] as const)("holds %s without another POST, deletion, or false finalization", async (outcome) => {
    mockProvider(outcome);
    const first = await create();
    expect(first[0]).toMatchObject({ success: false, reconciliationRequired: true });
    const shipmentId = String(shipmentRows()[0]!.id);
    expect(orderState()).toMatchObject({ status: "confirmed", shipment_claim_id: shipmentId, shipment_claim_expires_at: null });
    expect(shipmentRows()).toEqual([expect.objectContaining({ status: "reconcile_required", raw_status: "provider_outcome_unknown", external_id: null })]);
    expect(JSON.stringify([first, shipmentRows()])).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
    await expect(reconcileOrderShipment(db as never, "order_local", shipmentId)).rejects.toThrow("provider confirmation");
    await expect(deleteShipmentRecord(db as never, shipmentId)).rejects.toThrow();
    expect((await create())[0]).toMatchObject({
      success: false,
      error: "Shipment creation or recovery is active. Check shipment history before trying again.",
    });
    expect(createPosts).toBe(1);
    expect(shipmentRows()).toHaveLength(1);
    expect(orderState()?.status).toBe("confirmed");
    expect(applyInventoryForStatusChangeWithImpact).not.toHaveBeenCalled();
  });

  it("records accountable existing-booking confirmation before finalizing locally", async () => {
    mockProvider("network");
    await create();
    const shipmentId = String(shipmentRows()[0]!.id);
    const expectedOrderVersion = Number(orderState()!.version);
    const result = await resolveUnknownOrderShipment(db as never, {
      orderId: "order_local",
      shipmentId,
      expectedOrderVersion,
      operationKey: "00000000-0000-4000-8000-000000000001",
      outcome: "confirmed_existing",
      evidenceSource: "courier_support",
      evidenceNote: "Courier support confirmed this consignment belongs to order_local.",
      confirmationAccepted: true,
      externalId: "confirmed-consignment",
      trackingId: "confirmed-tracking",
      actorId: "admin_local",
      encryptionKey: key,
    });
    expect(result).toMatchObject({ status: "repaired", resolution: "merchant_confirmed_existing", claimCleared: true });
    expect(orderState()).toMatchObject({ status: "shipped", shipment_claim_id: null });
    expect(shipmentRows()[0]).toMatchObject({ status: "pending", external_id: "confirmed-consignment" });
    expect(JSON.parse(String(shipmentRows()[0]!.metadata))).toMatchObject({
      unknownOutcomeResolution: {
        method: "merchant_attestation",
        outcome: "confirmed_existing",
        actorId: "admin_local",
        operationKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    await expect(checkShipmentStatus(db as never, shipmentId, key)).resolves.toMatchObject({
      shipmentId,
      status: expect.any(String),
    });
    expect(JSON.parse(String(shipmentRows()[0]!.metadata))).toMatchObject({
      unknownOutcomeResolution: {
        method: "merchant_attestation",
        outcome: "confirmed_existing",
        actorId: "admin_local",
        operationKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(createPosts).toBe(1);
  });

  it("releases only the current claimed attempt after confirmed non-creation", async () => {
    mockProvider("network");
    await create();
    const shipmentId = String(shipmentRows()[0]!.id);
    const expectedOrderVersion = Number(orderState()!.version);
    const result = await resolveUnknownOrderShipment(db as never, {
      orderId: "order_local",
      shipmentId,
      expectedOrderVersion,
      operationKey: "00000000-0000-4000-8000-000000000002",
      outcome: "confirmed_not_created",
      evidenceSource: "courier_portal",
      evidenceNote: "Courier portal and support confirmed no booking was created.",
      confirmationAccepted: true,
      actorId: "admin_local",
      encryptionKey: key,
    });
    expect(result).toMatchObject({ status: "released", resolution: "merchant_confirmed_not_created", claimCleared: true });
    expect(orderState()).toMatchObject({ status: "confirmed", version: expectedOrderVersion + 1, shipment_claim_id: null });
    expect(shipmentRows()[0]).toMatchObject({ status: "failed", raw_status: "confirmed_not_created" });
    expect(JSON.parse(String(shipmentRows()[0]!.metadata))).toMatchObject({
      unknownOutcomeResolution: { actorId: "admin_local", outcome: "confirmed_not_created" },
    });
    mockProvider("success");
    expect((await create())[0]?.success).toBe(true);
    expect(createPosts).toBe(2);
  });

  it("keeps the lock when the order version changed before confirmation", async () => {
    mockProvider("network");
    await create();
    const shipmentId = String(shipmentRows()[0]!.id);
    const staleVersion = Number(orderState()!.version);
    sqlite.exec("UPDATE orders SET version = version + 1 WHERE id = 'order_local'");
    await expect(resolveUnknownOrderShipment(db as never, {
      orderId: "order_local",
      shipmentId,
      expectedOrderVersion: staleVersion,
      operationKey: "00000000-0000-4000-8000-000000000003",
      outcome: "confirmed_cancelled",
      evidenceSource: "courier_support",
      evidenceNote: "Courier support confirmed cancellation after reviewing the order.",
      confirmationAccepted: true,
      actorId: "admin_local",
      encryptionKey: key,
    })).rejects.toThrow("Order changed");
    expect(orderState()?.shipment_claim_id).toBe(shipmentId);
    expect(shipmentRows()[0]).toMatchObject({ status: "reconcile_required", raw_status: "provider_outcome_unknown" });
  });

  if (providerType === "steadfast") {
    it("does not permit rebooking while Steadfast cancellation awaits approval", async () => {
      mockProvider("success");
      expect((await create())[0]?.success).toBe(true);
      const shipmentId = String(shipmentRows()[0]!.id);
      const pendingCancellation = mapProviderStatus("steadfast", "cancelled_approval_pending");
      await updateOrderStatusFromShipment(db as never, shipmentId, pendingCancellation);
      expect(orderState()?.status).toBe("shipped");
      expect((await create())[0]).toMatchObject({ success: true, message: "Order already shipped; inventory reconciled" });
      expect(createPosts).toBe(1);

      await updateOrderStatusFromShipment(db as never, shipmentId, mapProviderStatus("steadfast", "cancelled"));
      expect(orderState()?.status).toBe("confirmed");
      mockProvider("success");
      expect((await create())[0]?.success).toBe(true);
      expect(createPosts).toBe(2);
    });

    it("uses invoice lookup only as positive existing-booking proof", async () => {
      mockProvider("network");
      await create();
      const shipmentId = String(shipmentRows()[0]!.id);
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://courier.invalid/status_by_invoice/order_local");
        expect(init?.method).toBe("GET");
        return Response.json({ status: 200, delivery_status: "in_review" });
      }));
      const result = await lookupUnknownOrderShipment(db as never, {
        orderId: "order_local",
        shipmentId,
        expectedOrderVersion: Number(orderState()!.version),
        operationKey: "00000000-0000-4000-8000-000000000004",
        actorId: "admin_local",
        encryptionKey: key,
      });
      expect(result).toMatchObject({ status: "repaired", resolution: "provider_confirmed_existing" });
      expect(orderState()).toMatchObject({ status: "shipped", shipment_claim_id: null });
      expect(JSON.parse(String(shipmentRows()[0]!.metadata))).toMatchObject({
        unknownOutcomeResolution: {
          method: "provider_lookup",
          evidenceSource: "provider_api_invoice_lookup",
          actorId: "admin_local",
        },
      });
    });

    it.each(["unknown", "unknown_approval_pending", "provider_added_a_new_state"])(
      "retains the lock for unrecognized Steadfast invoice state %s",
      async (deliveryStatus) => {
        mockProvider("network");
        await create();
        const shipmentId = String(shipmentRows()[0]!.id);
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: 200, delivery_status: deliveryStatus })));
        await expect(lookupUnknownOrderShipment(db as never, {
          orderId: "order_local",
          shipmentId,
          expectedOrderVersion: Number(orderState()!.version),
          operationKey: "00000000-0000-4000-8000-000000000008",
          actorId: "admin_local",
          encryptionKey: key,
        })).rejects.toThrow("recognized shipment state");
        expect(orderState()).toMatchObject({ status: "confirmed", shipment_claim_id: shipmentId });
        expect(shipmentRows()[0]).toMatchObject({ status: "reconcile_required", raw_status: "provider_outcome_unknown" });
      },
    );

    it("never converts a failed invoice lookup into confirmed absence", async () => {
      mockProvider("network");
      await create();
      const shipmentId = String(shipmentRows()[0]!.id);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
      await expect(lookupUnknownOrderShipment(db as never, {
        orderId: "order_local",
        shipmentId,
        expectedOrderVersion: Number(orderState()!.version),
        operationKey: "00000000-0000-4000-8000-000000000005",
        actorId: "admin_local",
        encryptionKey: key,
      })).rejects.toThrow("lock remains active");
      expect(orderState()?.shipment_claim_id).toBe(shipmentId);
      expect(shipmentRows()[0]).toMatchObject({ status: "reconcile_required", raw_status: "provider_outcome_unknown" });
    });

    it("requires an explicit cancellation record when invoice lookup reports final cancellation", async () => {
      mockProvider("network");
      await create();
      const shipmentId = String(shipmentRows()[0]!.id);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: 200, delivery_status: "cancelled" })));
      await expect(lookupUnknownOrderShipment(db as never, {
        orderId: "order_local",
        shipmentId,
        expectedOrderVersion: Number(orderState()!.version),
        operationKey: "00000000-0000-4000-8000-000000000007",
        actorId: "admin_local",
        encryptionKey: key,
      })).rejects.toThrow("Record a courier-confirmed cancellation");
      expect(orderState()).toMatchObject({ status: "confirmed", shipment_claim_id: shipmentId });
      expect(shipmentRows()[0]).toMatchObject({ status: "reconcile_required", raw_status: "provider_outcome_unknown" });
    });

    it("blocks a not-created attestation when invoice lookup confirms a booking", async () => {
      mockProvider("network");
      await create();
      const shipmentId = String(shipmentRows()[0]!.id);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: 200, delivery_status: "pending" })));
      await expect(resolveUnknownOrderShipment(db as never, {
        orderId: "order_local",
        shipmentId,
        expectedOrderVersion: Number(orderState()!.version),
        operationKey: "00000000-0000-4000-8000-000000000006",
        outcome: "confirmed_not_created",
        evidenceSource: "courier_support",
        evidenceNote: "Support initially reported that the booking did not exist.",
        confirmationAccepted: true,
        actorId: "admin_local",
        encryptionKey: key,
      })).rejects.toThrow("Steadfast confirms a shipment");
      expect(orderState()?.shipment_claim_id).toBe(shipmentId);
    });
  }

  it("releases a known validation rejection for a safe corrected retry", async () => {
    mockProvider("rejected");
    const first = await create();
    expect(first[0]?.error).toContain("rejected the shipment (HTTP 422)");
    expect(JSON.stringify([first, shipmentRows()])).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
    expect(orderState()).toMatchObject({ status: "confirmed", shipment_claim_id: null });
    expect(shipmentRows()[0]).toMatchObject({ status: "failed", raw_status: "provider_rejected" });
    mockProvider("success");
    expect((await create())[0]?.success).toBe(true);
    expect(createPosts).toBe(2);
  });

  it("persists known success and does not call the provider on retry", async () => {
    mockProvider("success");
    expect((await create())[0]?.success).toBe(true);
    expect(orderState()).toMatchObject({ status: "shipped", shipment_claim_id: null });
    expect(shipmentRows()[0]).toMatchObject({ status: "pending", external_id: providerType === "pathao" ? "synthetic-consignment" : "924" });
    expect((await create())[0]?.success).toBe(true);
    expect(createPosts).toBe(1);
  });

  it("does not turn an expired unknown claim into provider proof", async () => {
    mockProvider("network");
    await create();
    const shipmentId = String(shipmentRows()[0]!.id);
    sqlite.exec("UPDATE orders SET shipment_claim_expires_at = unixepoch() - 1");
    expect((await create())[0]).toMatchObject({ success: false, reconciliationRequired: true });
    expect(shipmentRows()[0]?.raw_status).toBe("provider_outcome_unknown");
    expect(orderState()?.shipment_claim_expires_at).toBeNull();
    await expect(reconcileOrderShipment(db as never, "order_local", shipmentId)).rejects.toThrow("provider confirmation");
    expect(createPosts).toBe(1);
  });

  it("does not treat an expired creating placeholder as provider confirmation", async () => {
    sqlite.exec(`
      INSERT INTO delivery_shipments (id, order_id, provider_id, provider_type, status, raw_status, metadata)
      VALUES ('shipment_expired', 'order_local', 'provider_local', '${providerType}', 'reconcile_required',
        'expired_order_shipment_claim', '{"reconciliation":{"providerStatus":"creating"}}');
      UPDATE orders SET shipment_claim_id = 'shipment_expired', shipment_claim_expires_at = NULL;
    `);
    await expect(reconcileOrderShipment(db as never, "order_local", "shipment_expired"))
      .rejects.toThrow("no provider proof");
    expect(orderState()?.status).toBe("confirmed");
    expect(applyInventoryForStatusChangeWithImpact).not.toHaveBeenCalled();
  });

  it.each(["network", "success"] as const)("retains the creating placeholder and claim when %s cannot be persisted", async (outcome) => {
    mockProvider(outcome, true);
    expect((await create())[0]).toMatchObject({ reconciliationRequired: true });
    const shipmentId = String(shipmentRows()[0]!.id);
    expect(shipmentRows()[0]).toMatchObject({ status: "creating", external_id: null });
    expect(orderState()).toMatchObject({ status: "confirmed", shipment_claim_id: shipmentId, shipment_claim_expires_at: null });
    await expect(deleteShipmentRecord(db as never, shipmentId)).rejects.toThrow();
    sqlite.exec("DROP TRIGGER fail_shipment_write; UPDATE orders SET shipment_claim_expires_at = unixepoch() - 1");
    expect((await create())[0]).toMatchObject({ success: false, reconciliationRequired: true });
    expect(shipmentRows()[0]?.raw_status).toBe("provider_outcome_unknown");
    await expect(reconcileOrderShipment(db as never, "order_local", shipmentId)).rejects.toThrow("provider confirmation");
    expect(createPosts).toBe(1);
  });

  it("repairs successful provider creation after local inventory failure without another POST", async () => {
    mockProvider("success");
    vi.mocked(applyInventoryForStatusChangeWithImpact).mockRejectedValueOnce(new Error("Synthetic inventory failure"));
    expect((await create())[0]).toMatchObject({ reconciliationRequired: true });
    const shipmentId = String(shipmentRows()[0]!.id);
    expect(await reconcileOrderShipment(db as never, "order_local", shipmentId)).toMatchObject({ status: "repaired", claimCleared: true });
    expect(orderState()).toMatchObject({ status: "shipped", inventory_action: "deducted", shipment_claim_id: null });
    expect(createPosts).toBe(1);
  });

  if (providerType === "pathao") {
    it("releases a preparation failure before any shipment POST", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("SENSITIVE-UPSTREAM-DETAIL token failure"); }));
      const first = await create();
      expect(first[0]).toMatchObject({ success: false });
      expect(first[0]?.reconciliationRequired).not.toBe(true);
      expect(JSON.stringify([first, shipmentRows()])).not.toContain("SENSITIVE-UPSTREAM-DETAIL");
      expect(orderState()?.shipment_claim_id).toBeNull();
      expect(createPosts).toBe(0);
    });
  }
});
