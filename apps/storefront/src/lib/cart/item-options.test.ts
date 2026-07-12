import { describe, expect, it } from "vitest";

import {
  cartItemVariantLabel,
  MAX_CART_ITEM_OPTIONS,
  normalizeCartItemOptions,
} from "./item-options";

describe("cart item options", () => {
  it("preserves merchant-defined option order across every supported axis", () => {
    const options = [
      { name: " Weight ", label: " 2KG " },
      { name: "Roast", label: "Medium" },
      { name: "Packaging", label: "Gift box" },
    ];

    expect(normalizeCartItemOptions(options)).toEqual([
      { name: "Weight", label: "2KG" },
      { name: "Roast", label: "Medium" },
      { name: "Packaging", label: "Gift box" },
    ]);
    expect(cartItemVariantLabel(options)).toBe("2KG / Medium / Gift box");
  });

  it("bounds untrusted metadata and ignores malformed or duplicate axes", () => {
    const options = [
      null,
      { name: "", label: "missing name" },
      { name: "Axis 1", label: "Value 1" },
      { name: "axis 1", label: "duplicate" },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `Axis ${index + 2}`,
        label: `Value ${index + 2}`,
      })),
    ];

    const normalized = normalizeCartItemOptions(options);
    expect(normalized).toHaveLength(MAX_CART_ITEM_OPTIONS);
    expect(normalized?.map((option) => option.name)).toEqual([
      "Axis 1",
      "Axis 2",
      "Axis 3",
      "Axis 4",
      "Axis 5",
    ]);
  });

  it("keeps the checkout variant label within the API contract", () => {
    const label = cartItemVariantLabel(
      Array.from({ length: MAX_CART_ITEM_OPTIONS }, (_, index) => ({
        name: `Axis ${index + 1}`,
        label: "🙂".repeat(160),
      })),
    );

    expect(label?.length).toBeLessThanOrEqual(200);
    const lastCodeUnit = label?.charCodeAt((label?.length ?? 0) - 1) ?? 0;
    expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
  });
});
