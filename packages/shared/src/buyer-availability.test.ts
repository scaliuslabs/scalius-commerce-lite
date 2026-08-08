import { describe, expect, it } from "vitest";
import {
  maskPublicBuyerAvailability,
  resolveBuyerAvailabilityBand,
} from "./buyer-availability";

describe("buyer availability projection", () => {
  it("resolves the same public bands used by cache invalidation", () => {
    expect(
      resolveBuyerAvailabilityBand({ stock: 0, trackInventory: true }),
    ).toBe("out_of_stock");
    expect(
      resolveBuyerAvailabilityBand({
        stock: 3,
        reservedStock: 1,
        lowStockThreshold: 2,
      }),
    ).toBe("low_stock");
    expect(
      resolveBuyerAvailabilityBand({
        stock: 4,
        reservedStock: 1,
        lowStockThreshold: 2,
      }),
    ).toBe("in_stock");
    expect(
      resolveBuyerAvailabilityBand({
        stock: 4,
        reservedStock: 1,
        lowStockThreshold: 5,
      }),
    ).toBe("low_stock");
    expect(
      resolveBuyerAvailabilityBand({ stock: 0, trackInventory: false }),
    ).toBe("untracked");
  });

  it("makes exact quantities within one band indistinguishable", () => {
    expect(
      maskPublicBuyerAvailability({
        stock: 40,
        reservedStock: 2,
        trackInventory: true,
        lowStockThreshold: 5,
      }),
    ).toEqual(
      maskPublicBuyerAvailability({
        stock: 12,
        reservedStock: 3,
        trackInventory: true,
        lowStockThreshold: 5,
      }),
    );

    expect(
      maskPublicBuyerAvailability({
        stock: 5,
        reservedStock: 1,
        trackInventory: true,
        lowStockThreshold: 5,
      }),
    ).toEqual(
      maskPublicBuyerAvailability({
        stock: 2,
        reservedStock: 1,
        trackInventory: true,
        lowStockThreshold: 5,
      }),
    );
  });

  it("keeps compatibility sentinels aligned with the public band", () => {
    expect(
      maskPublicBuyerAvailability({
        stock: 3,
        reservedStock: 2,
        trackInventory: true,
        lowStockThreshold: 5,
      }),
    ).toMatchObject({
      stock: 5,
      reservedStock: 0,
      availabilityBand: "low_stock",
    });
    expect(
      maskPublicBuyerAvailability({
        stock: 200,
        reservedStock: 0,
        trackInventory: true,
        lowStockThreshold: 120,
      }),
    ).toMatchObject({
      stock: 121,
      reservedStock: 0,
      availabilityBand: "in_stock",
    });
  });
});
