import { describe, expect, it } from "vitest";
import {
  getBuyerStockSummary,
  resolveBuyerVariants,
} from "./product-sellable-variants";

type TestVariant = {
  id: string;
  deletedAt: string | null;
  isDefault?: boolean;
  size: string | null;
  color: string | null;
  stock: number;
  reservedStock?: number;
  trackInventory?: boolean;
};

function variant(overrides: Partial<TestVariant> = {}): TestVariant {
  return {
    id: "var_simple",
    deletedAt: null,
    isDefault: false,
    size: null,
    color: null,
    stock: 0,
    reservedStock: 0,
    trackInventory: true,
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

  it("uses only customer-option SKUs when hidden defaults coexist with real options", () => {
    const hiddenDefault = variant({
      id: "var_default_prod_1",
      isDefault: true,
      trackInventory: false,
    });
    const optionSku = variant({
      id: "var_red_m",
      size: "M",
      color: "Red",
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

  it("summarizes stock from buyer-visible SKUs only", () => {
    expect(getBuyerStockSummary([
      variant({ id: "var_default_prod_1", isDefault: true, trackInventory: false }),
    ])).toMatchObject({ canPurchaseAny: true, text: "In Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_red_m", size: "M", stock: 3, reservedStock: 1 }),
    ])).toMatchObject({ canPurchaseAny: true, text: "Low Stock" });

    expect(getBuyerStockSummary([
      variant({ id: "var_red_m", size: "M", stock: 1, reservedStock: 1 }),
    ])).toMatchObject({ canPurchaseAny: false, text: "Out of Stock" });
  });
});
