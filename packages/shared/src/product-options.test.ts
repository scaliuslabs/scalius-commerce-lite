import { describe, expect, it } from "vitest";

import {
  classifyProductVariantOptionAxes,
  getProductVariantOptionAxis,
} from "./product-options";

describe("product variant option-axis classification", () => {
  it.each([
    [{ size: "M", color: null }, "option1"],
    [{ size: null, color: "Red" }, "option2"],
    [{ size: "M", color: "Red" }, "option1_option2"],
    [{ size: "  ", color: null }, null],
  ] as const)("classifies one SKU's saved option fields", (variant, expected) => {
    expect(getProductVariantOptionAxis(variant)).toBe(expected);
  });

  it("accepts one consistent option shape", () => {
    expect(classifyProductVariantOptionAxes([
      { size: "M", color: "Red" },
      { size: "L", color: "Blue" },
    ])).toBe("option1_option2");
  });

  it("rejects mixed option axes", () => {
    expect(classifyProductVariantOptionAxes([
      { size: "42", color: null },
      { size: "41", color: "Green" },
    ])).toBe("mixed");
  });

  it("ignores no-option rows so callers can classify protected defaults separately", () => {
    expect(classifyProductVariantOptionAxes([
      { size: "M", color: null },
      { size: null, color: null },
    ])).toBe("option1");
  });

  it("reports none when no row has customer options", () => {
    expect(classifyProductVariantOptionAxes([
      { size: null, color: null },
    ])).toBe("none");
  });
});
