import { describe, expect, it, vi } from "vitest";
import {
  deliveryShipments,
  orderPayments,
  orders,
  paymentSessionAttempts,
  refundAttempts,
  ShipmentStatus,
} from "@scalius/database/schema";
import {
  checkShipmentStatus,
  createShipment,
  deleteShipmentRecord,
  saveDeliveryProvider,
} from "./delivery.service";

function createDeleteShipmentDb({
  shipment,
  orderClaim,
  activeRefundAttempt = null,
  legacyPendingRefund = null,
  activePaymentSessionAttemptRows = [],
}: {
  shipment?: Record<string, unknown> | null;
  orderClaim?: Record<string, unknown> | null;
  activeRefundAttempt?: Record<string, unknown> | null;
  legacyPendingRefund?: Record<string, unknown> | null;
  activePaymentSessionAttemptRows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];

  const chainFor = (result: unknown) => {
    const chain = {
      where: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      get: vi.fn(async () => result ?? null),
      all: vi.fn(async () => Array.isArray(result) ? result : result ? [result] : []),
    };
    return chain;
  };

  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table === deliveryShipments) return chainFor(shipment ?? null);
          if (table === refundAttempts) return chainFor(activeRefundAttempt);
          if (table === orderPayments) return chainFor(legacyPendingRefund);
          if (table === paymentSessionAttempts) return chainFor(activePaymentSessionAttemptRows);
          if (table === orders) return chainFor(orderClaim ?? null);
          return chainFor(null);
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where: async () => undefined,
          };
        },
      };
    },
    delete() {
      return {
        where: async () => {
          deletes.push("delivery_shipments");
        },
      };
    },
  };

  return { db, updates, deletes };
}

function shipment(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "shp_1",
    orderId: "order_1",
    status,
    ...overrides,
  };
}

function createSaveProviderDb(existingProvider: Record<string, unknown> | null = null) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(existingProvider ? [existingProvider] : [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        writes.push(values);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        writes.push(values);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  return { db, writes };
}

function thenableRows(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), {
    get: vi.fn(async () => rows[0] ?? null),
    all: vi.fn(async () => rows),
  });
}

function createSequentialSelectDb(results: unknown[][]) {
  const selectResults = [...results];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => thenableRows(selectResults.shift() ?? [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        inserts.push(values);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  return { db, inserts, updates };
}

describe("deleteShipmentRecord claim safety", () => {
  it("rejects creating shipments without deleting", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.CREATING),
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("provider creation is in progress");
    expect(deletes).toHaveLength(0);
  });

  it("rejects active refund operations before shipment-status delete checks", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.CREATING),
      activeRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "provider_unknown" },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("active refund operation");
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it("rejects legacy pending refunds before deleting shipments", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.FAILED),
      legacyPendingRefund: { id: "refund_pending" },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("active refund operation");
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it("rejects reconcile_required shipments even without an order claim", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.RECONCILE_REQUIRED),
      orderClaim: null,
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("requires reconciliation");
    expect(deletes).toHaveLength(0);
  });

  it("rejects deletion when the linked order has a future active claim", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.FAILED),
      orderClaim: {
        shipmentClaimId: "shp_1",
        shipmentClaimExpiresAt: Date.now() + 60_000,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("shipment creation is in progress");
    expect(deletes).toHaveLength(0);
  });

  it("rejects deletion when the linked order has an indefinite active claim", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.FAILED),
      orderClaim: {
        shipmentClaimId: "shp_1",
        shipmentClaimExpiresAt: null,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("shipment creation is in progress");
    expect(deletes).toHaveLength(0);
  });

  it("rejects expired matching claims for nonterminal shipment rows", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.PENDING),
      orderClaim: {
        shipmentClaimId: "shp_1",
        shipmentClaimExpiresAt: 1,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("unresolved expired shipment claim");
    expect(deletes).toHaveLength(0);
  });

  it("deletes unclaimed failed shipments", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.FAILED),
      orderClaim: {
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1")).resolves.toBe(true);
    expect(updates).toHaveLength(0);
    expect(deletes).toEqual(["delivery_shipments"]);
  });

  it("clears expired matching failed shipment claims before deleting", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.FAILED),
      orderClaim: {
        shipmentClaimId: "shp_1",
        shipmentClaimExpiresAt: 1,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1")).resolves.toBe(true);
    expect(updates[0]).toMatchObject({
      shipmentClaimId: null,
      shipmentClaimExpiresAt: null,
    });
    expect(deletes).toEqual(["delivery_shipments"]);
  });

  it("allows unrelated shipment deletion when an order only has an expired claim for another shipment", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.PENDING),
      orderClaim: {
        shipmentClaimId: "shp_other",
        shipmentClaimExpiresAt: 1,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1")).resolves.toBe(true);
    expect(updates).toHaveLength(0);
    expect(deletes).toEqual(["delivery_shipments"]);
  });
});

describe("saveDeliveryProvider credential storage", () => {
  it("fails closed before writing credentials without an encryption key", async () => {
    const { db, writes } = createSaveProviderDb();

    await expect(saveDeliveryProvider(db as never, {
      id: "provider_pathao",
      name: "Pathao",
      type: "pathao",
      isActive: true,
      credentials: { clientSecret: "secret", password: "pass" },
      config: { storeId: "store_1" },
    }, "")).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("encrypts delivery provider credentials before insert", async () => {
    const { db, writes } = createSaveProviderDb();
    const key = Buffer.alloc(32, 9).toString("base64");

    await saveDeliveryProvider(db as never, {
      id: "provider_pathao",
      name: "Pathao",
      type: "pathao",
      isActive: true,
      credentials: { clientSecret: "secret", password: "pass" },
      config: { storeId: "store_1" },
    }, key);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.credentials).toEqual(expect.any(String));
    expect(writes[0]?.credentials).not.toBe(JSON.stringify({ clientSecret: "secret", password: "pass" }));
    expect(writes[0]?.credentials).toContain(":");
  });
});

describe("delivery provider active-state authority", () => {
  it("does not create a shipment through an inactive provider", async () => {
    const { db, inserts } = createSequentialSelectDb([
      [{ id: "order_1", totalAmount: 100, paidAmount: 0 }],
      [{
        id: "provider_pathao",
        type: "pathao",
        isActive: false,
        credentials: "{}",
        config: "{}",
      }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
    )).resolves.toMatchObject({
      success: false,
      message: "Provider with ID provider_pathao is not active",
    });

    expect(inserts).toHaveLength(0);
  });

  it("does not poll shipment status through an inactive provider", async () => {
    const { db, updates } = createSequentialSelectDb([
      [{
        id: "shipment_1",
        orderId: "order_1",
        providerId: "provider_steadfast",
        externalId: "consignment_1",
      }],
      [],
      [],
      [],
      [{ shipmentClaimId: null, shipmentClaimExpiresAt: null }],
      [{
        id: "provider_steadfast",
        type: "steadfast",
        isActive: false,
        credentials: "{}",
        config: "{}",
      }],
    ]);

    await expect(checkShipmentStatus(
      db as never,
      "shipment_1",
    )).rejects.toThrow("Provider with ID provider_steadfast is not active");

    expect(updates).toHaveLength(0);
  });

  it("does not poll shipment status while a refund attempt is active", async () => {
    const { db, updates } = createSequentialSelectDb([
      [{
        id: "shipment_1",
        orderId: "order_1",
        providerId: "provider_steadfast",
        externalId: "consignment_1",
      }],
      [{ id: "rfa_1", orderId: "order_1", status: "provider_unknown" }],
    ]);

    await expect(checkShipmentStatus(
      db as never,
      "shipment_1",
    )).rejects.toThrow("active refund operation");

    expect(updates).toHaveLength(0);
  });

  it("rejects Pathao shipment creation before placeholder insert when location mappings are missing", async () => {
    const { db, inserts } = createSequentialSelectDb([
      [{
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }],
      [{
        id: "provider_pathao",
        type: "pathao",
        isActive: true,
        credentials: "{}",
        config: "{}",
      }],
      [{ id: "city_1", externalIds: "{}" }],
      [{ id: "zone_1", externalIds: "{}" }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
    )).resolves.toMatchObject({
      success: false,
      message: "Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: city, zone. Configure Pathao IDs in Delivery Locations settings.",
    });

    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid Pathao numeric mappings before provider work", async () => {
    const { db, inserts } = createSequentialSelectDb([
      [{
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }],
      [{
        id: "provider_pathao",
        type: "pathao",
        isActive: true,
        credentials: "{}",
        config: "{}",
      }],
      [{ id: "city_1", externalIds: JSON.stringify({ pathao: 0 }) }],
      [{ id: "zone_1", externalIds: JSON.stringify({ pathao: "1.5" }) }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
    )).resolves.toMatchObject({
      success: false,
      message: "Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: city, zone. Configure Pathao IDs in Delivery Locations settings.",
    });

    expect(inserts).toHaveLength(0);
  });
});
