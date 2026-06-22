// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { parseVariantFromDOM } from "./variant-state-machine";

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
