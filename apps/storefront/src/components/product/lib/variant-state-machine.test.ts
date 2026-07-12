import { describe, expect, it } from "vitest";
import {
  createInitialSelection,
  filterVariantsBySelection,
  getVariantOptionAvailabilityMap,
  reconcileSelectionForValue,
  resolveExactVariantSelection,
  validateSelection,
  type Variant,
} from "./variant-state-machine";
import type { ProductOptionDefinition } from "@/lib/api";

const options: ProductOptionDefinition[] = [
  { id: "size", name: "Size", position: 0, standardMapping: "size", values: [
    { id: "small", value: "Small", position: 0 },
    { id: "large", value: "Large", position: 1 },
  ] },
  { id: "finish", name: "Finish", position: 1, standardMapping: "none", values: [
    { id: "matte", value: "Matte", position: 0 },
    { id: "gloss", value: "Gloss", position: 1 },
  ] },
];

function variant(id: string, size: string, finish: string, stock = 2): Variant {
  return {
    id,
    productId: "prod_1",
    optionCombinationKey: `${size}|${finish}`,
    imageId: null,
    selectedOptions: [
      { optionDefinitionId: "size", optionValueId: size, name: "Size", value: size, position: 0, valuePosition: 0, standardMapping: "size" },
      { optionDefinitionId: "finish", optionValueId: finish, name: "Finish", value: finish, position: 1, valuePosition: 0, standardMapping: "none" },
    ],
    weight: null,
    sku: id,
    price: 100,
    stock,
    reservedStock: 0,
    isDefault: false,
    trackInventory: true,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    deletedAt: null,
  };
}

const variants = [
  variant("sm", "small", "matte"),
  variant("sg", "small", "gloss", 0),
  variant("lm", "large", "matte"),
  variant("lg", "large", "gloss"),
];

describe("generic product option selection", () => {
  it("filters and resolves an exact arbitrary-axis combination", () => {
    expect(filterVariantsBySelection(variants, { size: "small" })).toHaveLength(2);
    expect(resolveExactVariantSelection(variants, { size: "large", finish: "gloss" })?.variant.id).toBe("lg");
  });

  it("reports contextual availability without hiding globally valid values", () => {
    expect(getVariantOptionAvailabilityMap(variants, "finish", ["matte", "gloss"], { size: "small" }).get("gloss")).toBe("sold_out");
    expect(getVariantOptionAvailabilityMap(variants, "finish", ["matte", "gloss"], { size: "large" }).get("gloss")).toBe("available");
  });

  it("clears conflicting selections when choosing a valid value", () => {
    const sparse = variants.filter((item) => item.id !== "lg");
    expect(reconcileSelectionForValue(sparse, "finish", "gloss", { size: "large" }, ["size", "finish"]))
      .toEqual({ finish: "gloss" });
  });

  it("auto-selects only single available values", () => {
    const singleOptions = [{ ...options[0]!, values: [options[0]!.values[0]!] }];
    expect(createInitialSelection(singleOptions, variants)).toEqual({ size: "small" });
    expect(createInitialSelection(options, variants)).toEqual({});
  });

  it("requires all axes and an available exact SKU", () => {
    expect(validateSelection({ size: "small" }, options, variants).valid).toBe(false);
    expect(validateSelection({ size: "small", finish: "gloss" }, options, variants).valid).toBe(false);
    expect(validateSelection({ size: "large", finish: "matte" }, options, variants).valid).toBe(true);
  });
});
