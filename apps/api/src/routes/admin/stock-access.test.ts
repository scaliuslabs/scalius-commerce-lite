import { describe, expect, it } from "vitest";
import { rowSetsStock, writeSetsStock } from "./stock-access";

describe("which product writes set stock (products.adjust_stock)", () => {
  it("counts a saved SKU's quantity edit and a new SKU's starting stock above zero", () => {
    expect(rowSetsStock({ stock: 4, expectedStockVersion: 2 })).toBe(true);
    expect(rowSetsStock({ stock: 0, expectedStockVersion: 2 })).toBe(true);
    expect(rowSetsStock({ stock: 3 })).toBe(true);
    expect(rowSetsStock({ stock: 0 })).toBe(false);
    expect(rowSetsStock({})).toBe(false);
    expect(rowSetsStock(null)).toBe(false);
  });

  it("looks at the hidden SKU, the option matrix rows and a SKU body", () => {
    expect(writeSetsStock({ name: "Shirt" })).toBe(false);
    expect(writeSetsStock({ defaultSku: { sku: "S-1", stock: 5 } })).toBe(true);
    expect(writeSetsStock({ optionMatrix: { variants: [{ id: "a" }, { id: "b", stock: 2, expectedStockVersion: 1 }] } })).toBe(true);
    expect(writeSetsStock({ options: [], variants: [{ id: "a", stock: 0 }] })).toBe(false);
    expect(writeSetsStock({ variants: [{ id: "a", stock: 1 }] })).toBe(true);
    expect(writeSetsStock({ sku: "S-2", stock: 7, expectedStockVersion: 3 })).toBe(true);
  });
});
