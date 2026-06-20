import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { reserveStockBatch } from "./reserve";

function createMissingVariantDb(): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => undefined),
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
    const db = createMissingVariantDb();

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
});
