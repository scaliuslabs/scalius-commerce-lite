import { describe, expect, it, vi } from "vitest";
import { productLowStockAlerts } from "@scalius/database/schema";
import { acknowledgeLowStockAlert, checkAndAlertLowStock } from "./alerts";

type VariantState = {
  id: string;
  productId: string;
  stock: number;
  reservedStock: number;
  lowStockThreshold: number | null;
  trackInventory: boolean;
};

function createAlertDbMock(
  variants: Array<VariantState | null>,
  alerts: Array<{ id: string; alertStatus: string } | null>,
) {
  const variantQueue = [...variants];
  const alertQueue = [...alerts];
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];

  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => "lowStockThreshold" in projection
                  ? variantQueue.shift() ?? null
                  : alertQueue.shift() ?? null,
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => {
              updates.push({ table, values });
            },
          };
        },
      };
    },
  };

  return { db, updates };
}

describe("low-stock alert lifecycle", () => {
  it("resolves an active alert after restock and reactivates it after later depletion", async () => {
    const { db, updates } = createAlertDbMock(
      [
        {
          id: "variant_1",
          productId: "product_1",
          stock: 10,
          reservedStock: 0,
          lowStockThreshold: 5,
          trackInventory: true,
        },
        {
          id: "variant_1",
          productId: "product_1",
          stock: 3,
          reservedStock: 0,
          lowStockThreshold: 5,
          trackInventory: true,
        },
      ],
      [
        { id: "alert_1", alertStatus: "active" },
        { id: "alert_1", alertStatus: "resolved" },
      ],
    );

    const restocked = await checkAndAlertLowStock(db as never, "variant_1");
    const depleted = await checkAndAlertLowStock(db as never, "variant_1");

    expect(restocked).toMatchObject({
      isLow: false,
      alertResolved: true,
      availableStock: 10,
    });
    expect(depleted).toMatchObject({
      isLow: true,
      alertReactivated: true,
      availableStock: 3,
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      table: productLowStockAlerts,
      values: { alertStatus: "resolved", currentQty: 10 },
    });
    expect(updates[1]).toMatchObject({
      table: productLowStockAlerts,
      values: {
        alertStatus: "active",
        currentQty: 3,
        acknowledgedAt: null,
        resolvedAt: null,
      },
    });
  });

  it("resolves stale alerts when a SKU is dormant or alerting is disabled", async () => {
    const { db, updates } = createAlertDbMock(
      [
        null,
        {
          id: "variant_2",
          productId: "product_1",
          stock: 8,
          reservedStock: 2,
          lowStockThreshold: null,
          trackInventory: true,
        },
      ],
      [],
    );

    await expect(checkAndAlertLowStock(db as never, "dormant_variant")).resolves.toBeNull();
    await expect(checkAndAlertLowStock(db as never, "variant_2")).resolves.toBeNull();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      table: productLowStockAlerts,
      values: { alertStatus: "resolved" },
    });
    expect(updates[1]).toMatchObject({
      table: productLowStockAlerts,
      values: { alertStatus: "resolved", currentQty: 6 },
    });
  });
});

describe("low-stock alert acknowledgement", () => {
  it.each([
    [[{ id: "alert_1" }], true],
    [[], false],
  ] as const)("reports whether an active alert was acknowledged", async (rows, expected) => {
    const returning = vi.fn().mockResolvedValue(rows);
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({ returning }),
        }),
      }),
    };

    await expect(acknowledgeLowStockAlert(db as never, "variant_1")).resolves.toBe(expected);
    expect(returning).toHaveBeenCalledOnce();
  });
});
