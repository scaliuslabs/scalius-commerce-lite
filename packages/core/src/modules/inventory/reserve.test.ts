import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { reserveStockBatch } from "./reserve";

function createReservationReadDb(rows: unknown[]): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            all: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
    update: vi.fn(),
    insert: vi.fn(),
  } as unknown as Database;
}

describe("reserveStockBatch sellability guard", () => {
  it("fails before writing when the reservation-time variant read is not sellable", async () => {
    const db = createReservationReadDb([]);

    const result = await reserveStockBatch(
      db,
      [{ variantId: "variant_deleted", quantity: 1, orderId: "order_1" }],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(result).toMatchObject({
      success: false,
      error: "Variant variant_deleted not found",
      results: [
        {
          success: false,
          variantId: "variant_deleted",
        },
      ],
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("loads reservation-time variant states with one batched read", async () => {
    const db = createReservationReadDb([
      {
        id: "variant_a",
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        trackInventory: false,
        stockVersion: 1,
      },
      {
        id: "variant_b",
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        trackInventory: false,
        stockVersion: 7,
      },
    ]);

    const result = await reserveStockBatch(
      db,
      [
        { variantId: "variant_a", quantity: 1, orderId: "order_1" },
        { variantId: "variant_b", quantity: 2, orderId: "order_1" },
      ],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(result.success).toBe(true);
    expect(result.results.map((item) => item.variantId)).toEqual(["variant_a", "variant_b"]);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
