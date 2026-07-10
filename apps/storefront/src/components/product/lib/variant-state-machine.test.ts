// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  createVariantIndex,
  filterVariantsBySelection,
  getVariantOptionAvailability,
  getSelectionStatus,
  parseVariantFromDOM,
  resolveExactAvailableVariantSelection,
  resolveExactVariantSelection,
  toggleVariantOption,
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

  it("preserves fractional prices and discounts from fallback DOM data", () => {
    const element = document.createElement("button");
    element.dataset.variantPrice = "1.234";
    element.dataset.variantDiscountedPrice = "1.111";
    element.dataset.variantDiscount = "0.123";
    element.dataset.variantDiscountPercentage = "10.5";
    element.dataset.variantDiscountAmount = "0.005";

    expect(parseVariantFromDOM(element)).toMatchObject({
      price: 1.234,
      discountedPrice: 1.111,
      discount: 0.123,
      discountPercentage: 10.5,
      discountAmount: 0.005,
    });
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

  it("does not auto-select a sole sold-out or fully reserved option axis", () => {
    const reserved = {
      ...pricedVariant({
        id: "var_42_red",
        size: "42",
        color: "Red",
        price: 4_500,
      }),
      stock: 1,
      reservedStock: 1,
    };
    const index = createVariantIndex([reserved]);
    const initial = createInitialState(index);

    expect(initial).toMatchObject({
      selectedSize: undefined,
      selectedColor: undefined,
      selectedVariant: null,
    });
    expect(initial.sizeOptionAvailability.get("42")).toBe("sold_out");
    expect(initial.colorOptionAvailability.get("Red")).toBe("sold_out");
    expect(
      resolveExactAvailableVariantSelection([reserved], {
        selectedSize: "42",
        selectedColor: "Red",
      }),
    ).toBeNull();
  });

  it("auto-selects a sole untracked option even when its numeric stock is zero", () => {
    const untracked = {
      ...pricedVariant({
        id: "var_42_red",
        size: "42",
        color: "Red",
        price: 4_500,
      }),
      stock: 0,
      trackInventory: false,
    };
    const index = createVariantIndex([untracked]);

    expect(createInitialState(index)).toMatchObject({
      selectedSize: "42",
      selectedColor: "Red",
      selectedVariant: untracked,
    });
    expect(
      resolveExactAvailableVariantSelection([untracked], {
        selectedSize: "42",
        selectedColor: "Red",
      })?.variant,
    ).toEqual(untracked);
  });

  it("keeps SELECT actions idempotent for auto-selected single axes", () => {
    const red = pricedVariant({
      id: "var_42_red",
      size: "42",
      color: "Red",
      price: 4_500,
    });
    const green = pricedVariant({
      id: "var_42_green",
      size: "42",
      color: "Green",
      price: 4_000,
    });
    const index = createVariantIndex([red, green]);
    const initial = createInitialState(index);

    expect(initial.selectedSize).toBe("42");
    const hydratedSize = applyAction(
      initial,
      { type: "SELECT_SIZE", value: "42" },
      index,
    );
    expect(hydratedSize.selectedSize).toBe("42");
  });

  it("resolves only complete valid query selections", () => {
    const red = pricedVariant({
      id: "var_42_red",
      size: "42",
      color: "Red",
      price: 4_500,
    });
    const green = pricedVariant({
      id: "var_42_green",
      size: "42",
      color: "Green",
      price: 4_000,
    });
    const variants = [red, green];

    expect(
      resolveExactVariantSelection(variants, {
        selectedSize: "42",
        selectedColor: "Green",
      }),
    ).toEqual({
      variant: green,
      selectedSize: "42",
      selectedColor: "Green",
    });
    expect(
      resolveExactVariantSelection(variants, { selectedSize: "42" }),
    ).toBeNull();
    expect(
      resolveExactVariantSelection(variants, {
        selectedSize: "99",
        selectedColor: "Green",
      }),
    ).toBeNull();

    const simple = pricedVariant({
      id: "var_default",
      size: null,
      color: null,
      price: 4_500,
    });
    expect(
      resolveExactVariantSelection([simple], { selectedSize: "42" }),
    ).toBeNull();

    const sizeOnly = pricedVariant({
      id: "var_40",
      size: "40",
      color: null,
      price: 4_500,
    });
    expect(
      resolveExactVariantSelection([sizeOnly], {
        selectedSize: "40",
        selectedColor: "Red",
      }),
    ).toBeNull();
    expect(
      resolveExactVariantSelection([sizeOnly], { selectedSize: "40" })?.variant,
    ).toEqual(sizeOnly);
  });

  it("scopes partial-selection candidates to every selected axis", () => {
    const size40 = pricedVariant({
      id: "var_40_red",
      size: "40",
      color: "Red",
      price: 45_600,
    });
    const size42 = pricedVariant({
      id: "var_42_green",
      size: "42",
      color: "Green",
      price: 4_500,
    });

    expect(
      filterVariantsBySelection([size40, size42], {
        selectedSize: "40",
      }),
    ).toEqual([size40]);
  });

  it("switches between disjoint available combinations without radio deadlock", () => {
    const size40Red = pricedVariant({
      id: "var_40_red",
      size: "40",
      color: "Red",
      price: 45_000,
    });
    const size41Green = pricedVariant({
      id: "var_41_green",
      size: "41",
      color: "Green",
      price: 4_500,
    });
    const index = createVariantIndex([size40Red, size41Green]);
    let state = createInitialState(index);

    state = applyAction(state, { type: "SELECT_SIZE", value: "40" }, index);
    state = applyAction(state, { type: "SELECT_COLOR", value: "Red" }, index);
    expect(state.selectedVariant).toEqual(size40Red);

    state = applyAction(state, { type: "SELECT_SIZE", value: "41" }, index);
    expect(state).toMatchObject({
      selectedSize: "41",
      selectedColor: undefined,
      selectedVariant: null,
    });
    expect(state.availableSizes).toEqual(new Set(["40", "41"]));
    expect(state.availableColors).toEqual(new Set(["Red", "Green"]));

    state = applyAction(state, { type: "SELECT_COLOR", value: "Green" }, index);
    expect(state.selectedVariant).toEqual(size41Green);

    state = applyAction(state, { type: "SELECT_COLOR", value: "Red" }, index);
    expect(state).toMatchObject({
      selectedSize: undefined,
      selectedColor: "Red",
      selectedVariant: null,
    });
  });

  it("distinguishes compatible, incompatible, and globally sold-out values", () => {
    const variants = [
      pricedVariant({
        id: "var_40_red",
        size: "40",
        color: "Red",
        price: 45_000,
      }),
      {
        ...pricedVariant({
          id: "var_40_blue",
          size: "40",
          color: "Blue",
          price: 44_000,
        }),
        stock: 1,
        reservedStock: 1,
      },
      pricedVariant({
        id: "var_42_green",
        size: "42",
        color: "Green",
        price: 4_500,
      }),
    ];

    expect(
      getVariantOptionAvailability(variants, "color", "Red", {
        selectedSize: "40",
      }),
    ).toBe("available");
    expect(
      getVariantOptionAvailability(variants, "color", "Green", {
        selectedSize: "40",
      }),
    ).toBe("incompatible");
    expect(
      getVariantOptionAvailability(variants, "color", "Blue", {
        selectedSize: "40",
      }),
    ).toBe("sold_out");
  });

  it("recomputes compatibility after select, toggle-clear, and reset", () => {
    const index = createVariantIndex([
      pricedVariant({
        id: "var_40_red",
        size: "40",
        color: "Red",
        price: 45_000,
      }),
      pricedVariant({
        id: "var_42_green",
        size: "42",
        color: "Green",
        price: 4_500,
      }),
    ]);
    let state = createInitialState(index);

    state = applyAction(state, { type: "SELECT_SIZE", value: "40" }, index);
    expect(state.colorOptionAvailability.get("Red")).toBe("available");
    expect(state.colorOptionAvailability.get("Green")).toBe("incompatible");

    state = applyAction(state, { type: "TOGGLE_SIZE", value: "40" }, index);
    expect(state.selectedSize).toBeUndefined();
    expect(state.colorOptionAvailability.get("Green")).toBe("available");

    state = applyAction(state, { type: "SELECT_COLOR", value: "Red" }, index);
    state = applyAction(state, { type: "RESET" }, index);
    expect(state).toMatchObject({
      selectedSize: undefined,
      selectedColor: undefined,
      selectedVariant: null,
    });
    expect(state.sizeOptionAvailability.get("42")).toBe("available");
  });

  it("toggles a selected value off and rejects globally sold-out selection", () => {
    const available = pricedVariant({
      id: "var_40_red",
      size: "40",
      color: "Red",
      price: 45_000,
    });
    const soldOut = {
      ...pricedVariant({
        id: "var_42_green",
        size: "42",
        color: "Green",
        price: 4_500,
      }),
      stock: 0,
    };

    expect(
      toggleVariantOption(
        [available, soldOut],
        { selectedSize: "40", selectedColor: "Red" },
        "size",
        "40",
      ),
    ).toEqual({ selectedColor: "Red", clearedAxis: "size" });
    expect(
      toggleVariantOption(
        [available, soldOut],
        { selectedSize: "40", selectedColor: "Red" },
        "size",
        "42",
      ),
    ).toEqual({ selectedSize: "40", selectedColor: "Red" });
  });
});
