import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryShipments,
  orderPayments,
  orders,
  paymentSessionAttempts,
  refundAttempts,
  ShipmentStatus,
} from "@scalius/database/schema";

// The fake database serves only the shipment reads; the location stock
// pre-check is covered by the fulfilment ledger D1 tests.
vi.mock("../inventory/inventory-transitions", () => ({
  assertOrderStockCoverable: async () => undefined,
}));

import {
  checkShipmentStatus,
  createShipment,
  deleteShipmentRecord,
  getDeliveryProviderActionReadiness,
  saveDeliveryProvider,
  testDeliveryProvider,
} from "./delivery.service";
import type { ShipmentOptions } from "./types";
import type { Courier } from "./couriers/port";
import { createCourierProviders } from "./couriers/registry";
import { getDeliveryProviderReadinessSummary } from "./provider-readiness";

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

const COURIER_ID = "acme.parcel:parcel";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An app courier as delivery code meets it: its setup from the app (here: ready unless told otherwise). */
function parcelCourier(options: { blocked?: string; unreadable?: string; preflight?: string } = {}) {
  const courier: Courier = {
    id: COURIER_ID,
    label: "Parcel",
    countries: ["BD"],
    async setup(provider) {
      const blockers = options.blocked ? [{ source: "config" as const, key: "app", label: "Parcel", message: options.blocked }] : [];
      const readiness = getDeliveryProviderReadinessSummary({ type: provider.type, activationBlockers: blockers, isActive: provider.isActive });
      return options.unreadable
        ? { settings: null, error: options.unreadable, unreadable: true, readiness }
        : { settings: { app: "parcel" }, readiness };
    },
    createShipment: vi.fn(async () => ({ externalId: "external_1", trackingId: "tracking_1", status: "pending" as const, rawStatus: "Pending", chargeMinor: null, label: null })),
    trackShipment: vi.fn(async () => ({ status: "in_transit" as const, rawStatus: "In transit", updatedAt: new Date().toISOString() })),
    testConnection: vi.fn(async () => ({ ok: true, message: "Connection successful" })),
    ...(options.preflight ? { preflight: async () => options.preflight! } : {}),
  };
  return { courier, couriers: createCourierProviders([courier]) };
}

function parcelProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider_parcel",
    name: "Parcel",
    type: COURIER_ID,
    isActive: true,
    credentials: "{}",
    config: "{}",
    lastTestAttemptAt: null,
    lastTestSuccessAt: null,
    lastTestFailureAt: null,
    lastTestSuccessFingerprint: null,
    ...overrides,
  };
}

const bdOrder = {
  id: "order_1",
  currencyDecimalPlaces: 2,
  totalAmountMinor: 10_000,
  paidAmountMinor: 0,
  balanceDueMinor: 10_000,
  shippingAddress: "House 1, Road 2",
  customerPhone: "+8801712345678",
  shippingCountryCode: "BD",
  city: "city_1",
  zone: "zone_1",
  area: null,
};

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

  it("rejects deletion of active shipments even when an unrelated order claim expired", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.PENDING),
      orderClaim: {
        shipmentClaimId: "shp_other",
        shipmentClaimExpiresAt: 1,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("Active and fulfilled shipment history must be preserved");
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it("rejects deletion of manual in-transit fulfillment shipments", async () => {
    const { db, updates, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.IN_TRANSIT),
      orderClaim: {
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
      },
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("Active and fulfilled shipment history must be preserved");
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe("saving a courier", () => {
  it("keeps no keys on the row: the app's settings hold them", async () => {
    const { db, writes } = createSaveProviderDb();
    const { couriers } = parcelCourier();
    await saveDeliveryProvider(db as never, { id: "provider_parcel", name: "Parcel", type: COURIER_ID, isActive: true }, "key", couriers);
    expect(writes).toEqual([expect.objectContaining({ type: COURIER_ID, isActive: true, credentials: "{}", config: "{}" })]);
  });

  it("refuses to switch on a courier its app does not let ship, before writing", async () => {
    const { db, writes } = createSaveProviderDb();
    const { couriers } = parcelCourier({ blocked: "Activate Parcel in Apps to use it." });
    await expect(saveDeliveryProvider(db as never, { id: "provider_parcel", name: "Parcel", type: COURIER_ID, isActive: true }, "key", couriers))
      .rejects.toThrow("cannot be activated");
    expect(writes).toHaveLength(0);
  });
});

describe("testing a courier", () => {
  it("runs the app's connection test and records when it passed", async () => {
    const { courier, couriers } = parcelCourier();
    const { db, updates } = createSequentialSelectDb([[parcelProvider()]]);
    await expect(testDeliveryProvider(db as never, "provider_parcel", "key", couriers)).resolves.toEqual({ success: true, message: "Connection successful" });
    expect(courier.testConnection).toHaveBeenCalledTimes(1);
    expect(updates[1]).toMatchObject({ lastTestFailureAt: null });
  });

  it("calls nothing when the app's secrets cannot be read", async () => {
    const { courier, couriers } = parcelCourier({ unreadable: "Parcel credentials could not be opened. Save them again in the app's settings." });
    const { db } = createSequentialSelectDb([[parcelProvider()]]);
    const result = await testDeliveryProvider(db as never, "provider_parcel", "key", couriers);
    expect(result).toMatchObject({ success: false, message: expect.stringContaining("could not be opened") });
    expect(courier.testConnection).not.toHaveBeenCalled();
  });
});

describe("delivery provider active-state authority", () => {
  it("derives COD money and item facts instead of accepting caller overrides", async () => {
    const { courier, couriers } = parcelCourier();
    const { db } = createSequentialSelectDb([
      [{ ...bdOrder, totalAmountMinor: 18_000, paidAmountMinor: 3_000, balanceDueMinor: 15_000 }],
      [parcelProvider()],
      [{ quantity: 2, productName: "Aster Clogs" }],
    ]);

    await expect(createShipment(
      db as never,
      "order_1",
      "provider_parcel",
      {
        deliveryType: 48,
        codAmount: 1,
        itemCount: 999,
        itemDescription: "Browser-authored contents",
      } as ShipmentOptions,
      "key",
      { couriers },
    )).resolves.toMatchObject({ success: true });

    expect(courier.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_1",
        codAmountMinor: 15_000,
        decimalPlaces: 2,
        itemCount: 2,
        itemDescription: "Aster Clogs x2",
        options: expect.objectContaining({ deliveryType: 48 }),
      }),
      expect.objectContaining({ settings: { app: "parcel" } }),
    );
  });

  it("never books a courier outside its countries (MARKETS-DESIGN step 3a)", async () => {
    const { courier, couriers } = parcelCourier();
    const { db, inserts } = createSequentialSelectDb([
      [{
        id: "order_1",
        currencyDecimalPlaces: 2,
        totalAmountMinor: 10_000,
        paidAmountMinor: 0,
        balanceDueMinor: 10_000,
        customerName: "Tim",
        customerPhone: "+14155552671",
        shippingAddress: "1 Infinite Loop",
        shippingCountryCode: "US",
        shippingLocality: "Cupertino",
        city: null,
        zone: null,
        area: null,
      }],
      [parcelProvider()],
    ]);

    await expect(createShipment(db as never, "order_1", "provider_parcel", undefined, "key", { couriers }))
      .resolves.toEqual({ success: false, message: "Parcel doesn't deliver to US. Ship this order another way." });
    expect(courier.createShipment).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("does not create a shipment through an inactive provider", async () => {
    const { couriers } = parcelCourier();
    const { db, inserts } = createSequentialSelectDb([[bdOrder], [parcelProvider({ isActive: false })]]);
    await expect(createShipment(db as never, "order_1", "provider_parcel", undefined, "key", { couriers })).resolves.toMatchObject({
      success: false,
      message: "Delivery provider provider_parcel is not ready for shipment creation: Delivery provider is inactive.",
    });
    expect(inserts).toHaveLength(0);
  });

  it("does not create a shipment when the app's secrets cannot be read", async () => {
    const { courier, couriers } = parcelCourier({ unreadable: "Parcel credentials could not be opened. Save them again in the app's settings." });
    const { db, inserts } = createSequentialSelectDb([[bdOrder], [parcelProvider()]]);
    await expect(createShipment(db as never, "order_1", "provider_parcel", undefined, undefined, { couriers })).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("could not be opened"),
    });
    expect(courier.createShipment).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("does not poll shipment status through an inactive provider", async () => {
    const { db, updates } = createSequentialSelectDb([
      [{
        id: "shipment_1",
        orderId: "order_1",
        providerId: "provider_parcel",
        externalId: "consignment_1",
      }],
      [],
      [],
      [],
      [{ shipmentClaimId: null, shipmentClaimExpiresAt: null }],
      [parcelProvider({ isActive: false })],
    ]);

    await expect(checkShipmentStatus(
      db as never,
      "shipment_1",
    )).rejects.toThrow("Provider with ID provider_parcel is not active");

    expect(updates).toHaveLength(0);
  });

  it("does not poll shipment status while a refund attempt is active", async () => {
    const { db, updates } = createSequentialSelectDb([
      [{
        id: "shipment_1",
        orderId: "order_1",
        providerId: "provider_parcel",
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

  it("refuses a booking the courier's preflight refuses before the placeholder insert", async () => {
    const { courier, couriers } = parcelCourier({ preflight: "Parcel requires mapped location IDs before shipment creation. Missing mapping for: city, zone." });
    const { db, inserts } = createSequentialSelectDb([[bdOrder], [parcelProvider()]]);
    await expect(createShipment(db as never, "order_1", "provider_parcel", undefined, "key", { couriers })).resolves.toMatchObject({
      success: false,
      message: "Parcel requires mapped location IDs before shipment creation. Missing mapping for: city, zone.",
    });
    expect(courier.createShipment).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
