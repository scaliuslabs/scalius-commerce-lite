import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, inventoryOperations, productVariants } from "@scalius/database/schema";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import {
  adjustInventory,
  decodeInventoryMovementCursor,
  encodeInventoryMovementCursor,
  getInventoryOverview,
  listInventoryMovements,
} from "./inventory.service";
import { checkAndAlertLowStock } from "./alerts";

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

type MockStatement = {
  kind: "insert" | "update";
  table: unknown;
  values?: Record<string, unknown>;
};

function createInventoryAdjustmentDbMock(variant: {
  id: string;
  stock: number;
  reservedStock?: number;
  preorderStock: number;
  stockVersion: number;
}) {
  const persistedVariant = { reservedStock: 0, ...variant };
  const batchCalls: MockStatement[][] = [];
  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                get: async () => table === inventoryOperations ? null : persistedVariant,
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        select() {
          return {
            returning() {
              return { kind: "insert" as const, table };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                returning() {
                  return { kind: "update" as const, table, values };
                },
              };
            },
          };
        },
      };
    },
    batch: async (statements: MockStatement[]) => {
      batchCalls.push(statements);
      return [
        [{ id: "movement_1" }],
        [{ operationKey: "invop_inventory_test_0001" }],
        [{ id: variant.id }],
      ];
    },
  };

  return { db, batchCalls };
}

describe("adjustInventory stock ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records manual stock adjustments in the same batch as the stockVersion update", async () => {
    const { db, batchCalls } = createInventoryAdjustmentDbMock({
      id: "variant_1",
      stock: 9,
      preorderStock: 0,
      stockVersion: 4,
    });

    const result = await adjustInventory(
      db as never,
      "variant_1",
      { operationKey: "invop_inventory_test_0001", delta: -3, reason: "damage", notes: "warehouse count" },
      "admin_1",
    );

    expect(result).toEqual({
      variantId: "variant_1",
      previousStock: 9,
      newStock: 6,
      delta: -3,
    });
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toMatchObject({
      kind: "insert",
      table: inventoryMovements,
    });
    expect(batchCalls[0]?.[2]).toMatchObject({
      kind: "update",
      table: productVariants,
      values: { stock: 6 },
    });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

  it("reconciles low-stock alerts after a positive manual restock", async () => {
    const { db } = createInventoryAdjustmentDbMock({
      id: "variant_1",
      stock: 2,
      preorderStock: 0,
      stockVersion: 4,
    });

    const result = await adjustInventory(
      db as never,
      "variant_1",
      { operationKey: "invop_inventory_test_0002", delta: 8, reason: "received", notes: "supplier delivery" },
      "admin_1",
    );

    expect(result).toMatchObject({ previousStock: 2, newStock: 10, delta: 8 });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

  it.each([
    [{ delta: 1.5, reason: "correction" }, /whole number|integer/i],
    [{ delta: 0, reason: "correction" }, /must not be zero/i],
    [{ delta: -1, reason: "received" }, /require a positive adjustment/i],
    [{ delta: 1, reason: "damage" }, /require a negative adjustment/i],
  ] as const)("rejects invalid manual adjustment semantics before reading stock", async (payload, message) => {
    const select = vi.fn();
    const db = { select };

    await expect(
      adjustInventory(db as never, "variant_1", {
        operationKey: "invop_inventory_invalid_01",
        ...payload,
      }),
    ).rejects.toThrow(message);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects manual adjustment overdrafts without writing a smaller movement", async () => {
    const { db, batchCalls } = createInventoryAdjustmentDbMock({
      id: "variant_1",
      stock: 2,
      preorderStock: 0,
      stockVersion: 4,
    });

    await expect(
      adjustInventory(db as never, "variant_1", {
        operationKey: "invop_inventory_overdraw_1",
        delta: -3,
        reason: "damage",
      }),
    ).rejects.toThrow(/resulting stock must be greater than or equal to zero/);
    expect(batchCalls).toHaveLength(0);
  });
});

describe("inventory overview query boundaries", () => {
  it("round-trips stable movement cursors and rejects malformed cursors", () => {
    const cursor = encodeInventoryMovementCursor({ createdAt: 1_720_000_000, id: "move/with spaces" });
    expect(decodeInventoryMovementCursor(cursor)).toEqual({
      createdAt: 1_720_000_000,
      id: "move/with spaces",
    });
    expect(() => decodeInventoryMovementCursor("invalid")).toThrow(/cursor/i);
    expect(() => decodeInventoryMovementCursor(`1|${"x".repeat(257)}`)).toThrow(/cursor/i);
  });

  it("uses a bounded keyset query for exact-order and Bangladesh date-filtered movement history", async () => {
    const queries: string[] = [];
    const bindings: unknown[][] = [];
    const d1 = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind: (...values: unknown[]) => {
            bindings.push(values);
            return statement;
          },
          all: async () => ({ results: [] }),
          raw: async () => [],
          first: async () => null,
        };
        return statement;
      },
    };
    const db = drizzle(d1 as unknown as D1Database, { schema });

    await expect(listInventoryMovements(db, {
      search: "SKU-EXACT",
      movementType: "deducted",
      orderId: "ord_exact_1",
      startDate: new Date("2026-07-01T18:00:00.000Z"),
      endDate: new Date("2026-07-02T17:59:59.999Z"),
      cursor: encodeInventoryMovementCursor({ createdAt: 1_720_000_000, id: "move_20" }),
      limit: 20,
    })).resolves.toMatchObject({
      movements: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.toLowerCase()).toContain('left join "user"');
    expect(queries[0]?.toLowerCase()).toContain("order by");
    expect(queries[0]?.toLowerCase()).toContain("limit ?");
    expect(queries[0]?.toLowerCase()).not.toContain("offset");
    expect(queries[0]).toContain('"inventory_movements"."order_id" = ?');
    expect(queries[0]).toContain('"inventory_movements"."id" < ?');
    expect(bindings[0]?.length).toBeLessThanOrEqual(90);
  });

  it("qualifies the correlated variant id in the normalized option-label projection", async () => {
    const queries: string[] = [];
    const d1 = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [] }),
          raw: async () => [],
          first: async () => null,
        };
        return statement;
      },
    };
    const db = drizzle(d1 as unknown as D1Database, { schema });

    await expect(getInventoryOverview(db, {
      section: "variants",
      search: "",
      status: "all",
      page: 1,
      limit: 50,
      sort: "available",
      order: "asc",
    })).resolves.toMatchObject({
      variants: [],
      pagination: { total: 0 },
    });

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain(
      'pvov.variant_id = "product_variants"."id"',
    );
    expect(queries[0]).not.toContain("pvov.variant_id = \"id\"");
    for (const query of queries) {
      expect(query.toLowerCase()).toContain('inner join "products"');
      expect(query.toLowerCase()).toContain('"products"."deleted_at" is null');
    }
  });

  it("keeps low-stock alert search and history bounded and paginated", async () => {
    const queries: string[] = [];
    const d1 = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: query.toLowerCase().includes("count(*)") ? [{ count: 23 }] : [] }),
          raw: async () => query.toLowerCase().includes("count(*)") ? [[23]] : [],
          first: async () => ({ count: 23 }),
        };
        return statement;
      },
    };
    const db = drizzle(d1 as unknown as D1Database, { schema });

    await expect(getInventoryOverview(db, {
      section: "alerts",
      search: "SKU-LOW",
      status: "all",
      alertStatus: "resolved",
      page: 2,
      limit: 10,
    })).resolves.toMatchObject({
      alerts: [],
      pagination: { page: 2, limit: 10, total: 23, totalPages: 3 },
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]?.toLowerCase()).toContain("count(*)");
    expect(queries[1]?.toLowerCase()).toContain("limit ? offset ?");
    expect(queries[1]).toContain('pvov.variant_id = "product_variants"."id"');
    for (const query of queries) {
      expect(query.toLowerCase()).toContain('inner join "products"');
      expect(query.toLowerCase()).toContain('"products"."deleted_at" is null');
      expect(query.toLowerCase()).toContain('"product_variants"."deleted_at" is null');
    }
  });

  it.each([
    [{ section: "unknown", search: "", status: "all", page: 1, limit: 50 }, /section/],
    [{ section: "variants", search: "", status: "unknown", page: 1, limit: 50 }, /status/],
    [{ section: "variants", search: "", status: "all", page: 0, limit: 50 }, /page/],
    [{ section: "variants", search: "", status: "all", page: 1, limit: 101 }, /page size/],
    [{ section: "movements", search: "", status: "all", page: 1, limit: 50, movementType: "unknown" }, /movement type/],
    [{ section: "variants", search: "", status: "all", page: 1, limit: 50, sort: "unknown" }, /sort/],
    [{ section: "variants", search: "", status: "all", page: 1, limit: 50, order: "sideways" }, /sort order/],
  ] as const)("rejects invalid list input before database work", async (params, message) => {
    const select = vi.fn();

    await expect(
      getInventoryOverview({ select } as never, params),
    ).rejects.toThrow(message);
    expect(select).not.toHaveBeenCalled();
  });
});
