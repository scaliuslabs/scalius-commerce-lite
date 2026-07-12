import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_OPTION_AXES,
  MAX_PRODUCT_OPTION_COMBINATIONS,
  isProductOptionStandardMapping,
  normalizeProductOptionIdentity,
} from "./product-options";

describe("normalized product option policy", () => {
  it("publishes the matrix limits shared by admin and core", () => {
    expect(MAX_PRODUCT_OPTION_AXES).toBe(5);
    expect(MAX_PRODUCT_OPTION_COMBINATIONS).toBe(150);
  });

  it("normalizes option identities without assuming an option name", () => {
    expect(normalizeProductOptionIdentity(" 2 In One ")).toBe("2 in one");
  });

  it.each(["size", "color", "material", "pattern", "none"])(
    "accepts the %s catalog mapping",
    (mapping) => expect(isProductOptionStandardMapping(mapping)).toBe(true),
  );

  it("rejects arbitrary values as catalog mappings", () => {
    expect(isProductOptionStandardMapping("shape")).toBe(false);
  });
});
