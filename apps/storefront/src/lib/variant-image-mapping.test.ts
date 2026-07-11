import { describe, expect, it } from "vitest";
import type {
  Product,
  ProductImage,
  ProductVariant,
  ProductVariantImageMapping,
} from "./api/types";
import {
  resolveProductVariantImageConfiguration,
  resolveVariantImageId,
} from "./variant-image-mapping";

const images: ProductImage[] = [
  { id: "img_primary", productId: "prod_1", url: "primary", alt: "", isPrimary: true, sortOrder: 1, createdAt: "2026-01-01" },
  { id: "img_red", productId: "prod_1", url: "red", alt: "", isPrimary: false, sortOrder: 0, createdAt: "2026-01-02" },
  { id: "img_exact", productId: "prod_1", url: "exact", alt: "", isPrimary: false, sortOrder: 2, createdAt: "2026-01-03" },
];
const mappings: ProductVariantImageMapping[] = [
  { id: "map_red", productId: "prod_1", imageId: "img_red", variantId: null, optionAxis: "option2", optionValue: "Red", normalizedOptionValue: "red", sortOrder: 0 },
  { id: "map_exact", productId: "prod_1", imageId: "img_exact", variantId: "var_red_m", optionAxis: null, optionValue: null, normalizedOptionValue: null, sortOrder: 0 },
];

describe("storefront variant image resolver", () => {
  it("prefers an exact SKU mapping, then the configured option value", () => {
    expect(resolveVariantImageId({
      enabled: true,
      axis: "option2",
      mappings,
      images,
      selectedVariantId: "var_red_m",
      selectedOptionValue: "Red",
    })).toBe("img_exact");
    expect(resolveVariantImageId({
      enabled: true,
      axis: "option2",
      mappings,
      images,
      selectedVariantId: "var_red_l",
      selectedOptionValue: " red ",
    })).toBe("img_red");
  });

  it("returns the true primary image for missing mappings and deselection", () => {
    expect(resolveVariantImageId({
      enabled: true,
      axis: "option2",
      mappings,
      images: [...images].reverse(),
      selectedOptionValue: "Blue",
    })).toBe("img_primary");
    expect(resolveVariantImageId({
      enabled: true,
      axis: "option2",
      mappings,
      images,
    })).toBe("img_primary");
  });

  it("does not positional-fallback for an explicit empty configuration", () => {
    const product = {
      id: "prod_1",
      variantImagesEnabled: true,
      variantImageAxis: "option2",
      metaDescription: "<!--variant_images:option1-->",
    } as Product;
    expect(resolveProductVariantImageConfiguration({
      product,
      images,
      variants: [] as ProductVariant[],
      mappings: [],
    })).toEqual({ enabled: true, axis: "option2", mappings: [] });
  });

  it("keeps a rolling-deploy legacy fallback for APIs without explicit fields", () => {
    const product = {
      id: "prod_1",
      metaDescription: "<!--variant_images:option1-->",
    } as Product;
    const variants = [{
      id: "var_small",
      productId: "prod_1",
      size: "Small",
      color: null,
      isDefault: false,
      deletedAt: null,
      sizeSortOrder: 0,
      colorSortOrder: 0,
      createdAt: "2026-01-01",
    }] as ProductVariant[];
    const result = resolveProductVariantImageConfiguration({
      product,
      images,
      variants,
      mappings: [],
    });
    expect(result.enabled).toBe(true);
    expect(result.axis).toBe("option1");
    expect(result.mappings[0]).toMatchObject({
      imageId: "img_red",
      optionValue: "Small",
    });
  });
});
