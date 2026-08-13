import type { Database } from "@scalius/database/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({ listInventoryMovements: vi.fn() }));
vi.mock("./inventory.service", () => ({
  listInventoryMovements: serviceMocks.listInventoryMovements,
}));

import {
  INVENTORY_MOVEMENT_EXPORT_MAX_BYTES,
  buildInventoryMovementCsvArtifact,
} from "./inventory-movement-artifacts";

const db = {} as Database;

function movement(overrides: Record<string, unknown> = {}) {
  return {
    id: "move_1",
    variantId: "var_1",
    orderId: "ord_1",
    type: "adjusted",
    quantity: 2,
    previousStock: 3,
    newStock: 5,
    notes: "+warehouse note",
    createdBy: "admin_1",
    actorName: "Admin One",
    actorType: "admin",
    ledgerVersion: 2,
    pool: "regular",
    reservationGeneration: 1,
    stockVersionBefore: 4,
    stockVersionAfter: 5,
    stockDelta: 2,
    previousReservedStock: 0,
    newReservedStock: 0,
    reservedStockDelta: 0,
    previousPreorderStock: 0,
    newPreorderStock: 0,
    preorderStockDelta: 0,
    createdAt: 1_720_000_000,
    variantSku: "=SKU-FORMULA",
    productName: "Product One",
    ...overrides,
  };
}

describe("inventory movement CSV artifacts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves list filters, paginates sequentially, and neutralizes spreadsheet formulas", async () => {
    serviceMocks.listInventoryMovements
      .mockResolvedValueOnce({
        movements: [movement()],
        pageInfo: { limit: 1, hasMore: true, nextCursor: "1720000000|move_1" },
      })
      .mockResolvedValueOnce({
        movements: [movement({ id: "move_0", variantSku: "SKU-2" })],
        pageInfo: { limit: 1, hasMore: false, nextCursor: null },
      });
    const startDate = new Date("2026-08-01T00:00:00.000Z");
    const endDate = new Date("2026-08-02T23:59:59.999Z");

    const artifact = await buildInventoryMovementCsvArtifact(db, {
      search: "SKU",
      movementType: "adjusted",
      orderId: "ord_1",
      startDate,
      endDate,
      maxRows: 2,
    });

    expect(artifact.body).toContain('"\'=SKU-FORMULA"');
    expect(artifact.body).toContain('"\'+warehouse note"');
    expect(artifact.body).toContain('"Admin One"');
    expect(artifact.byteLength).toBe(new TextEncoder().encode(artifact.body).byteLength);
    expect(artifact.rowCount).toBe(2);
    expect(serviceMocks.listInventoryMovements).toHaveBeenCalledTimes(2);
    expect(serviceMocks.listInventoryMovements.mock.calls[0]?.[1]).toMatchObject({
      search: "SKU",
      movementType: "adjusted",
      orderId: "ord_1",
      startDate,
      endDate,
      cursor: undefined,
      limit: 2,
    });
    expect(serviceMocks.listInventoryMovements.mock.calls[1]?.[1]).toMatchObject({
      cursor: "1720000000|move_1",
      limit: 1,
    });
  });

  it("fails closed before returning an artifact over the UTF-8 byte cap", async () => {
    serviceMocks.listInventoryMovements.mockResolvedValueOnce({
      movements: [movement({ notes: "é".repeat(INVENTORY_MOVEMENT_EXPORT_MAX_BYTES) })],
      pageInfo: { limit: 1, hasMore: false, nextCursor: null },
    });

    await expect(buildInventoryMovementCsvArtifact(db, { maxRows: 1 })).rejects.toThrow(
      `exceeds ${INVENTORY_MOVEMENT_EXPORT_MAX_BYTES} bytes`,
    );
  });

  it("rejects unbounded row requests before querying", async () => {
    await expect(buildInventoryMovementCsvArtifact(db, { maxRows: 5_001 })).rejects.toThrow(
      "Export from 1 through 5000 movement rows",
    );
    expect(serviceMocks.listInventoryMovements).not.toHaveBeenCalled();
  });
});
