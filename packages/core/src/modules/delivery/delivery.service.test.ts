import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryShipments,
  orderPayments,
  orders,
  paymentSessionAttempts,
  refundAttempts,
  ShipmentStatus,
} from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
}));

vi.mock("./factory", () => ({
  createProvider: mocks.createProvider,
}));

import {
  checkShipmentStatus,
  createShipment,
  deleteShipmentRecord,
  saveDeliveryProvider,
  testDeliveryProvider,
} from "./delivery.service";
import { getDeliveryProviderSetupFingerprint } from "./provider-readiness";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";

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
      from: vi.fn(() => {
        const rows = selectResults.shift() ?? [];
        const chain = {
          leftJoin: vi.fn(() => chain),
          where: vi.fn(() => thenableRows(rows)),
        };
        return chain;
      }),
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

const TEST_FINGERPRINT_KEY = Buffer.alloc(32, 7).toString("base64");

const completePathaoCredentials = {
  baseUrl: "https://api-hermes.pathao.com",
  clientId: "pathao-client-4821",
  clientSecret: "pathao-secret-9417",
  username: "merchant",
  password: "merchant-password-7813",
};

const completePathaoConfig = { storeId: "store_1" };

beforeEach(() => {
  vi.clearAllMocks();
});

async function readyPathaoProvider(overrides: Record<string, unknown> = {}) {
  const credentials = JSON.stringify(completePathaoCredentials);
  const config = JSON.stringify(completePathaoConfig);
  const fingerprint = await getDeliveryProviderSetupFingerprint({
    type: "pathao",
    credentials,
    config,
  }, TEST_FINGERPRINT_KEY);

  return {
    id: "provider_pathao",
    type: "pathao",
    isActive: true,
    credentials,
    config,
    lastTestSuccessAt: 100,
    lastTestFailureAt: null,
    lastTestSuccessFingerprint: fingerprint,
    ...overrides,
  };
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
      credentials: completePathaoCredentials,
      config: completePathaoConfig,
    }, key);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.credentials).toEqual(expect.any(String));
    expect(writes[0]?.credentials).not.toBe(JSON.stringify(completePathaoCredentials));
    expect(writes[0]?.credentials).toContain(":");
  });

  it("rejects active placeholder credentials before persistence", async () => {
    const { db, writes } = createSaveProviderDb();
    const key = Buffer.alloc(32, 9).toString("base64");

    await expect(saveDeliveryProvider(db as never, {
      id: "provider_pathao",
      name: "Pathao",
      type: "pathao",
      isActive: true,
      credentials: {
        ...completePathaoCredentials,
        clientSecret: "dummy",
      },
      config: completePathaoConfig,
    }, key)).rejects.toThrow("cannot be activated");

    expect(writes).toHaveLength(0);
  });

  it("preserves successful test proof when the saved setup fingerprint still matches", async () => {
    const fingerprint = await getDeliveryProviderSetupFingerprint({
      type: "pathao",
      credentials: JSON.stringify(completePathaoCredentials),
      config: JSON.stringify(completePathaoConfig),
    }, TEST_FINGERPRINT_KEY);
    const { db, writes } = createSaveProviderDb({
      id: "provider_pathao",
      lastTestSuccessFingerprint: fingerprint,
    });

    await saveDeliveryProvider(db as never, {
      id: "provider_pathao",
      name: "Pathao",
      type: "pathao",
      isActive: true,
      credentials: completePathaoCredentials,
      config: completePathaoConfig,
    }, TEST_FINGERPRINT_KEY);

    expect(writes[0]).not.toHaveProperty("lastTestAttemptAt");
    expect(writes[0]).not.toHaveProperty("lastTestSuccessFingerprint");
  });

  it("clears stale test proof when credentials or config change", async () => {
    const { db, writes } = createSaveProviderDb({
      id: "provider_pathao",
      lastTestAttemptAt: 100,
      lastTestSuccessAt: 100,
      lastTestFailureAt: null,
      lastTestSuccessFingerprint: "hmac-sha256:old",
    });

    await saveDeliveryProvider(db as never, {
      id: "provider_pathao",
      name: "Pathao",
      type: "pathao",
      isActive: true,
      credentials: completePathaoCredentials,
      config: { storeId: "store_2" },
    }, TEST_FINGERPRINT_KEY);

    expect(writes[0]).toMatchObject({
      lastTestAttemptAt: null,
      lastTestSuccessAt: null,
      lastTestFailureAt: null,
      lastTestSuccessFingerprint: null,
    });
  });
});

describe("testDeliveryProvider durable proof", () => {
  it("records attempt and matching successful fingerprint after a live test passes", async () => {
    const expectedFingerprint = await getDeliveryProviderSetupFingerprint({
      type: "pathao",
      credentials: JSON.stringify(completePathaoCredentials),
      config: JSON.stringify(completePathaoConfig),
    }, TEST_FINGERPRINT_KEY);
    const provider = await readyPathaoProvider({
      lastTestSuccessAt: null,
      lastTestSuccessFingerprint: null,
    });
    const { db, updates } = createSequentialSelectDb([[provider]]);
    mocks.createProvider.mockResolvedValueOnce({
      testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
    });

    await expect(testDeliveryProvider(db as never, "provider_pathao", TEST_FINGERPRINT_KEY))
      .resolves.toMatchObject({ success: true });

    expect(updates[0]).toHaveProperty("lastTestAttemptAt");
    expect(updates[1]).toMatchObject({
      lastTestFailureAt: null,
      lastTestSuccessFingerprint: expectedFingerprint,
    });
  });

  it("records failure without replacing the successful fingerprint when a live test fails", async () => {
    const provider = await readyPathaoProvider();
    const { db, updates } = createSequentialSelectDb([[provider]]);
    mocks.createProvider.mockResolvedValueOnce({
      testConnection: vi.fn(async () => ({ success: false, message: "rejected" })),
    });

    await expect(testDeliveryProvider(db as never, "provider_pathao", TEST_FINGERPRINT_KEY))
      .resolves.toMatchObject({ success: false, message: "rejected" });

    expect(updates[0]).toHaveProperty("lastTestAttemptAt");
    expect(updates[1]).toHaveProperty("lastTestFailureAt");
    expect(updates[1]).not.toHaveProperty("lastTestSuccessFingerprint");
  });

  it("does not call providers when encrypted test credentials have no dedicated key", async () => {
    const provider = await readyPathaoProvider({
      credentials: await encryptCredentials(
        JSON.stringify(completePathaoCredentials),
        TEST_FINGERPRINT_KEY,
      ),
    });
    const { db, updates } = createSequentialSelectDb([[provider]]);

    await expect(testDeliveryProvider(db as never, "provider_pathao"))
      .resolves.toMatchObject({
        success: false,
        message: expect.stringContaining("CREDENTIAL_ENCRYPTION_KEY"),
      });

    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(updates[0]).toHaveProperty("lastTestAttemptAt");
    expect(updates[1]).toHaveProperty("lastTestFailureAt");
  });

  it("does not dispatch tests for a saved provider with a non-public base URL", async () => {
    const provider = await readyPathaoProvider({
      credentials: JSON.stringify({
        ...completePathaoCredentials,
        baseUrl: "https://127.0.0.1/api/v1",
      }),
    });
    const { db, updates } = createSequentialSelectDb([[provider]]);

    await expect(testDeliveryProvider(db as never, "provider_pathao", TEST_FINGERPRINT_KEY))
      .resolves.toMatchObject({
        success: false,
        message: expect.stringContaining("cannot be activated"),
      });

    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(updates[0]).toHaveProperty("lastTestAttemptAt");
    expect(updates[1]).toHaveProperty("lastTestFailureAt");
  });
});

describe("delivery provider active-state authority", () => {
  it("derives COD money and item facts instead of accepting caller overrides", async () => {
    const provider = await readyPathaoProvider();
    const providerCreateShipment = vi.fn(async () => ({
      success: true,
      data: {
        externalId: "external_1",
        trackingId: "tracking_1",
        status: "pending",
      },
    }));
    mocks.createProvider.mockResolvedValueOnce({
      createShipment: providerCreateShipment,
    });
    const { db } = createSequentialSelectDb([
      [{
        id: "order_1",
        totalAmount: 180,
        paidAmount: 30,
        balanceDue: 150,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }],
      [provider],
      [{ id: "city_1", externalIds: JSON.stringify({ pathao: 1 }) }],
      [{ id: "zone_1", externalIds: JSON.stringify({ pathao: 2 }) }],
      [{ quantity: 2, productName: "Aster Clogs" }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
      {
        deliveryType: 48,
        codAmount: 1,
        itemCount: 999,
        itemDescription: "Browser-authored contents",
      },
      TEST_FINGERPRINT_KEY,
    )).resolves.toMatchObject({ success: true });

    expect(providerCreateShipment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "order_1" }),
      expect.objectContaining({
        deliveryType: 48,
        codAmount: 150,
        itemCount: 2,
        itemDescription: "Aster Clogs x2",
      }),
    );
  });

  it("does not create a shipment through an inactive provider", async () => {
    const provider = await readyPathaoProvider({ isActive: false });
    const { db, inserts } = createSequentialSelectDb([
      [{ id: "order_1", totalAmount: 100, paidAmount: 0 }],
      [provider],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
      undefined,
      TEST_FINGERPRINT_KEY,
    )).resolves.toMatchObject({
      success: false,
      message: "Delivery provider provider_pathao is not ready for shipment creation: Delivery provider is inactive.",
    });

    expect(inserts).toHaveLength(0);
  });

  it("does not create a shipment when encrypted provider credentials lack the dedicated key", async () => {
    const provider = await readyPathaoProvider({
      credentials: await encryptCredentials(
        JSON.stringify(completePathaoCredentials),
        TEST_FINGERPRINT_KEY,
      ),
    });
    const { db, inserts } = createSequentialSelectDb([
      [{ id: "order_1", totalAmount: 100, paidAmount: 0 }],
      [provider],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
    )).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("CREDENTIAL_ENCRYPTION_KEY"),
    });

    expect(mocks.createProvider).not.toHaveBeenCalled();
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
    const provider = await readyPathaoProvider();
    const { db, inserts } = createSequentialSelectDb([
      [{
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }],
      [provider],
      [{ id: "city_1", externalIds: "{}" }],
      [{ id: "zone_1", externalIds: "{}" }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
      undefined,
      TEST_FINGERPRINT_KEY,
    )).resolves.toMatchObject({
      success: false,
      message: "Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: city, zone. Configure Pathao IDs in Delivery Locations settings.",
    });

    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid Pathao numeric mappings before provider work", async () => {
    const provider = await readyPathaoProvider();
    const { db, inserts } = createSequentialSelectDb([
      [{
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }],
      [provider],
      [{ id: "city_1", externalIds: JSON.stringify({ pathao: 0 }) }],
      [{ id: "zone_1", externalIds: JSON.stringify({ pathao: "1.5" }) }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_pathao",
      undefined,
      TEST_FINGERPRINT_KEY,
    )).resolves.toMatchObject({
      success: false,
      message: "Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: city, zone. Configure Pathao IDs in Delivery Locations settings.",
    });

    expect(inserts).toHaveLength(0);
  });
});
