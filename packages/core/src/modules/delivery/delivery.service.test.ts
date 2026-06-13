import { describe, expect, it } from "vitest";
import { ShipmentStatus } from "@scalius/database/schema";
import { deleteShipmentRecord } from "./delivery.service";

function createDeleteShipmentDb({
  shipment,
  orderClaim,
}: {
  shipment?: Record<string, unknown> | null;
  orderClaim?: Record<string, unknown> | null;
}) {
  const selectResults = [shipment ?? null, orderClaim ?? null];
  const updates: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => selectResults.shift() ?? null,
              };
            },
          };
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

describe("deleteShipmentRecord claim safety", () => {
  it("rejects creating shipments without deleting", async () => {
    const { db, deletes } = createDeleteShipmentDb({
      shipment: shipment(ShipmentStatus.CREATING),
    });

    await expect(deleteShipmentRecord(db as never, "shp_1"))
      .rejects.toThrow("provider creation is in progress");
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
