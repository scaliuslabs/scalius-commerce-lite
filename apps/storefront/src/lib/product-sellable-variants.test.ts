import { describe, expect, it } from "vitest";
import {
  getBuyerStockSummary,
  resolveBuyerVariants,
} from "./product-sellable-variants";

type TestVariant = {
  id: string;
  deletedAt: string | null;
  isDefault?: boolean;
  optionCombinationKey: string | null;
  stock: number;
  reservedStock?: number;
  trackInventory?: boolean;
  lowStockThreshold?: number | null;
  availabilityBand?: "untracked" | "out_of_stock" | "low_stock" | "in_stock";
};

function variant(overrides: Partial<TestVariant> = {}): TestVariant {
  return {
    id: "var_simple",
    deletedAt: null,
    isDefault: false,
    optionCombinationKey: null,
    stock: 0,
    reservedStock: 0,
    trackInventory: true,
    lowStockThreshold: null,
    ...overrides,
  };
}

describe("product sellable variant resolution", () => {
  it("does not treat legacy synthetic default placeholders as sellable", () => {
    const resolution = resolveBuyerVariants([
      variant({ id: "default", trackInventory: false }),
    ]);

    expect(resolution).toMatchObject({
      mode: "unavailable",
      variants: [],
      hasCustomerOptions: false,
    });
  });

  it("resolves one active no-option SKU as a simple product", () => {
    const simpleSku = variant({
      id: "var_default_prod_1",
      isDefault: true,
      trackInventory: false,
    });

    const resolution = resolveBuyerVariants([simpleSku]);

    expect(resolution).toMatchObject({
      mode: "simple",
      variants: [simpleSku],
      hasCustomerOptions: false,
    });
  });

  it("does not treat a non-default no-option SKU as a simple product", () => {
    const resolution = resolveBuyerVariants([
      variant({
        id: "var_bad_simple",
        isDefault: false,
        trackInventory: false,
      }),
    ]);

    expect(resolution).toMatchObject({
      mode: "ambiguous",
      variants: [],
      hasCustomerOptions: false,
    });
  });

  it("uses only customer-option SKUs when hidden defaults coexist with real options", () => {
    const hiddenDefault = variant({
      id: "var_default_prod_1",
      isDefault: true,
      trackInventory: false,
    });
    const optionSku = variant({
      id: "var_red_m",
      optionCombinationKey: "m|red",
      stock: 8,
      trackInventory: true,
    });

    const resolution = resolveBuyerVariants([hiddenDefault, optionSku]);

    expect(resolution.mode).toBe("optioned");
    expect(resolution.hasCustomerOptions).toBe(true);
    expect(resolution.variants).toEqual([optionSku]);
  });

  it("marks ambiguous no-option SKU sets unavailable instead of guessing", () => {
    const resolution = resolveBuyerVariants([
      variant({ id: "var_one", isDefault: true, trackInventory: false }),
      variant({ id: "var_two", isDefault: false, trackInventory: false }),
    ]);

    expect(resolution).toMatchObject({
      mode: "ambiguous",
      variants: [],
    });
  });

  it("fails closed when an invalid empty combination coexists with option SKUs", () => {
    const resolution = resolveBuyerVariants([
      variant({ id: "var_size_42", optionCombinationKey: "42", stock: 4 }),
      variant({
        id: "var_size_41_green",
        optionCombinationKey: null,
        stock: 4,
      }),
    ]);

    expect(resolution).toMatchObject({
      mode: "ambiguous",
      variants: [],
      hasCustomerOptions: true,
    });
  });

  it("fails closed when a no-option non-default row coexists with option SKUs", () => {
    const resolution = resolveBuyerVariants([
      variant({ id: "var_size_m", optionCombinationKey: "m", stock: 4 }),
      variant({
        id: "var_invalid_no_option",
        isDefault: false,
        trackInventory: false,
      }),
    ]);

    expect(resolution).toMatchObject({
      mode: "ambiguous",
      variants: [],
      hasCustomerOptions: true,
    });
  });

  it("summarizes stock from buyer-visible SKUs only", () => {
    expect(getBuyerStockSummary([
      variant({ id: "var_default_prod_1", isDefault: true, trackInventory: false }),
    ])).toMatchObject({ canPurchaseAny: true, text: "In Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_red_m", optionCombinationKey: "m", stock: 3, reservedStock: 1 }),
    ])).toMatchObject({ canPurchaseAny: true, text: "In Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_red_m", optionCombinationKey: "m", stock: 3, reservedStock: 1, lowStockThreshold: 2 }),
    ])).toMatchObject({ canPurchaseAny: true, text: "Low Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_red_m", optionCombinationKey: "m", stock: 1, reservedStock: 1 }),
    ])).toMatchObject({ canPurchaseAny: false, text: "Out of Stock" });
  });

  it("shows aggregate low stock only when every purchasable SKU is below its saved threshold", () => {
    expect(getBuyerStockSummary([
      variant({ id: "var_low", stock: 3, lowStockThreshold: 5 }),
      variant({ id: "var_healthy", stock: 8, lowStockThreshold: 5 }),
      variant({ id: "var_sold_out", stock: 0, lowStockThreshold: 5 }),
    ])).toMatchObject({ canPurchaseAny: true, text: "In Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_low_one", stock: 3, lowStockThreshold: 5 }),
      variant({ id: "var_low_two", stock: 2, reservedStock: 1, lowStockThreshold: 5 }),
      variant({ id: "var_sold_out", stock: 0, lowStockThreshold: null }),
    ])).toMatchObject({ canPurchaseAny: true, text: "Low Stock" });
  });

  it("uses the cache-owned availability band instead of compatibility stock sentinels", () => {
    expect(getBuyerStockSummary([
      variant({ stock: 99, availabilityBand: "out_of_stock" }),
    ])).toMatchObject({ canPurchaseAny: false, text: "Out of Stock" });
    expect(getBuyerStockSummary([
      variant({ stock: 0, availabilityBand: "in_stock" }),
    ])).toMatchObject({ canPurchaseAny: true, text: "In Stock" });
    expect(getBuyerStockSummary([
      variant({ stock: 99, availabilityBand: "low_stock" }),
    ])).toMatchObject({ canPurchaseAny: true, text: "Low Stock" });
  });
});
