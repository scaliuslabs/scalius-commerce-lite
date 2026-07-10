// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  createVariantIndex,
  getSelectionStatus,
  parseVariantFromDOM,
  validateSelection,
} from "./variant-state-machine";

function pricedVariant(input: {
  id: string;
  size: string | null;
  color: string | null;
  price: number;
}) {
  return {
    ...input,
    discountedPrice: Math.round(input.price * 0.9),
    discount: 10,
    discountType: "percentage" as const,
    discountPercentage: 10,
    discountAmount: 0,
    stock: 5,
    reservedStock: 0,
    trackInventory: true,
    colorSortOrder: 0,
    sizeSortOrder: 0,
  };
}

describe("variant DOM fallback parsing", () => {
  it("preserves untracked inventory so simple SKUs do not become stock-zero", () => {
    const element = document.createElement("button");
    element.dataset.variantId = "var_simple";
    element.dataset.variantPrice = "5000";
    element.dataset.variantDiscountedPrice = "5000";
    element.dataset.variantStock = "0";
    element.dataset.variantReservedStock = "0";
    element.dataset.variantTrackInventory = "false";

    expect(parseVariantFromDOM(element)).toMatchObject({
      id: "var_simple",
      stock: 0,
      reservedStock: 0,
      trackInventory: false,
    });
  });

  it("keeps missing inventory tracking data undefined for older DOM nodes", () => {
    const element = document.createElement("button");
    element.dataset.variantId = "var_legacy";

    expect(parseVariantFromDOM(element).trackInventory).toBeUndefined();
  });
});

describe("variant selection validation", () => {
  it("fails closed when a product has no buyer SKU rows", () => {
    const index = createVariantIndex([]);
    const state = createInitialState(index);

    expect(validateSelection(state, index)).toEqual({
      valid: false,
      error: "This product is not available for checkout right now.",
      variant: null,
    });
    expect(getSelectionStatus(state, [])).toMatchObject({
      isComplete: false,
      requiredFields: [],
      missingFields: [],
    });
  });

  it("does not resolve the first matching SKU from a bare or partial option selection", () => {
    const highPriceFirst = pricedVariant({
      id: "var_40_red",
      size: "40",
      color: "Red",
      price: 45_600,
    });
    const lowerPriceLater = pricedVariant({
      id: "var_42_green",
      size: "42",
      color: "Green",
      price: 4_500,
    });
    const index = createVariantIndex([highPriceFirst, lowerPriceLater]);

    const initial = createInitialState(index);
    expect(initial.selectedVariant).toBeNull();

    const sizeOnly = applyAction(
      initial,
      { type: "SELECT_SIZE", value: "42" },
      index,
    );
    expect(sizeOnly.selectedVariant).toBeNull();

    const complete = applyAction(
      sizeOnly,
      { type: "SELECT_COLOR", value: "Green" },
      index,
    );
    expect(complete.selectedVariant).toEqual(lowerPriceLater);
  });

  it("resolves the only simple SKU without requiring buyer options", () => {
    const simpleSku = pricedVariant({
      id: "var_default",
      size: null,
      color: null,
      price: 4_500,
    });
    const index = createVariantIndex([simpleSku]);

    expect(createInitialState(index).selectedVariant).toEqual(simpleSku);
  });
});
