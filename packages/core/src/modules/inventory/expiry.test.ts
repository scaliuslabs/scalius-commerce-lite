import { describe, expect, it } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { releaseExpiredReservations } from "./expiry";

type ExpiredReservation = {
  variantId: string;
  orderId: string;
  totalQuantity: number;
};

function createDbMock(options: {
  expiredReservations: ExpiredReservation[];
  orderExists?: boolean;
  variant?: { stock: number; reservedStock: number } | null;
}) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];

  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                groupBy() {
                  return {
                    all: async () => options.expiredReservations,
                  };
                },
                get: async () => {
                  if ("id" in projection) return options.orderExists ? { id: "order_1" } : null;
                  if ("reservedStock" in projection) return options.variant ?? null;
                  return null;
                },
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
            where() {
              updates.push({ table, values });
              return {
                returning: async () => [],
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
        },
      };
    },
  };

  return { db, updates, inserts };
}

describe("releaseExpiredReservations", () => {
  const expiredReservations = [
    { variantId: "variant_1", orderId: "order_1", totalQuantity: 2 },
  ];

  it("does not release reservations for active live orders", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: true,
      variant: { stock: 10, reservedStock: 2 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 0, errors: [] });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("releases orphaned reservations whose order row no longer exists", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: false,
      variant: { stock: 10, reservedStock: 2 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({
      found: 1,
      released: 1,
      releasedVariantIds: ["variant_1"],
      errors: [],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: productVariants,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: inventoryMovements,
      values: {
        variantId: "variant_1",
        orderId: "order_1",
        type: "released",
        quantity: -2,
        previousStock: 10,
        newStock: 10,
      },
    });
  });

  it("skips release when an order appears between candidate selection and release", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: true,
      variant: { stock: 10, reservedStock: 2 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 0, errors: [] });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
