import { describe, expect, it } from "vitest";

import {
  addVariantImagesMarker,
  cleanMetaDescription,
  extractUniqueVariantOptionValues,
  getVariantImagesAxis,
  hasVariantImagesEnabled,
  resolveVariantImageAxis,
} from "./utils";

const variants = [
  {
    size: "2KG",
    color: "Red",
    sizeSortOrder: 2,
    colorSortOrder: 1,
    isDefault: false,
  },
  {
    size: "1KG",
    color: "Blue",
    sizeSortOrder: 1,
    colorSortOrder: 2,
    isDefault: false,
  },
  {
    size: "Default",
    color: "Default",
    sizeSortOrder: 0,
    colorSortOrder: 0,
    isDefault: true,
  },
];

describe("product form variant image metadata", () => {
  it("removes all variant-image markers from merchant meta description text", () => {
    expect(cleanMetaDescription("Fresh rice<!--variant_images:enabled-->")).toBe("Fresh rice");
    expect(cleanMetaDescription("Fresh rice<!--variant_images:option1-->")).toBe("Fresh rice");
    expect(cleanMetaDescription("Fresh rice<!--variant_images:option2-->")).toBe("Fresh rice");
  });

  it("detects legacy and axis-specific variant image markers", () => {
    expect(hasVariantImagesEnabled("<!--variant_images:enabled-->")).toBe(true);
    expect(hasVariantImagesEnabled("<!--variant_images:option1-->")).toBe(true);
    expect(hasVariantImagesEnabled("")).toBe(false);
  });

  it("defaults legacy image mapping to Option 2 and resolves Option 1 explicitly", () => {
    expect(getVariantImagesAxis("<!--variant_images:enabled-->")).toBe("option2");
    expect(getVariantImagesAxis("<!--variant_images:option2-->")).toBe("option2");
    expect(getVariantImagesAxis("<!--variant_images:option1-->")).toBe("option1");
  });

  it("writes only the selected image mapping axis marker", () => {
    expect(addVariantImagesMarker("Fresh rice", true, "option1")).toBe(
      "Fresh rice<!--variant_images:option1-->",
    );
    expect(addVariantImagesMarker("Fresh rice<!--variant_images:option2-->", true, "option1")).toBe(
      "Fresh rice<!--variant_images:option1-->",
    );
    expect(addVariantImagesMarker("Fresh rice<!--variant_images:option1-->", false, "option1")).toBe(
      "Fresh rice",
    );
  });

  it("extracts sorted customer option values without default SKU drift", () => {
    expect(extractUniqueVariantOptionValues(variants, "option1")).toEqual(["1KG", "2KG"]);
    expect(extractUniqueVariantOptionValues(variants, "option2")).toEqual(["Red", "Blue"]);
  });

  it("falls back to the axis that actually has option values", () => {
    expect(resolveVariantImageAxis("option2", ["One Size"], [])).toBe("option1");
    expect(resolveVariantImageAxis("option1", [], ["Red"])).toBe("option2");
    expect(resolveVariantImageAxis("option2", ["1KG"], ["Red"])).toBe("option2");
    expect(resolveVariantImageAxis("option1", [], [])).toBe("option1");
  });
});
