import { describe, expect, it } from "vitest";

import {
  cleanMetaDescription,
  extractUniqueVariantOptionValues,
  formatFormValuesForSubmission,
  getVariantImagesAxis,
  hasVariantImagesEnabled,
  resolveVariantImageAxis,
  reconcileVariantImageMappings,
} from "./utils";
import {
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  DEFAULT_PRODUCT_CONDITION,
  productFormSchema,
  type ProductFormValues,
} from "./types";

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

describe("stable product image mappings", () => {
  const images = [
    { id: "img_b", url: "b", filename: "b", size: 1, createdAt: new Date(2) },
    { id: "img_a", url: "a", filename: "a", size: 1, createdAt: new Date(1) },
  ];

  it("keeps option targets attached to image IDs when gallery order changes", () => {
    const mappings = reconcileVariantImageMappings({
      mappings: [],
      images,
      axis: "option1",
      optionValues: ["Small", "Large"],
      fillMissing: true,
    });
    const reordered = reconcileVariantImageMappings({
      mappings,
      images: [...images].reverse(),
      axis: "option1",
      optionValues: ["Small", "Large"],
    });

    expect(reordered).toEqual(mappings);
    expect(reordered).toMatchObject([
      { imageId: "img_b", optionValue: "Small" },
      { imageId: "img_a", optionValue: "Large" },
    ]);
  });

  it("drops only the removed image association and never positional-remaps", () => {
    const mappings = [
      { imageId: "img_b", optionAxis: "option1" as const, optionValue: "Small" },
      { imageId: "img_a", optionAxis: "option1" as const, optionValue: "Large" },
    ];
    expect(reconcileVariantImageMappings({
      mappings,
      images: [images[1]!],
      axis: "option1",
      optionValues: ["Small", "Large"],
    })).toEqual([
      expect.objectContaining({ imageId: "img_a", optionValue: "Large" }),
    ]);
  });
});

describe("product form catalog option mapping", () => {
  const baseValues: ProductFormValues = {
    name: "Main Shoe",
    description: "Comfortable everyday shoe.",
    price: 1200,
    categoryId: "cat_1",
    isActive: true,
    discountType: "percentage",
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: DEFAULT_PRODUCT_CONDITION,
    variantOption1Label: DEFAULT_PRODUCT_OPTION_LABELS.option1,
    variantOption2Label: DEFAULT_PRODUCT_OPTION_LABELS.option2,
    variantOption1Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
    variantOption2Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
    variantImagesEnabled: false,
    variantImageAxis: "option2",
    variantImageMappings: [],
    slug: "main-shoe",
    images: [],
    attributes: [],
    additionalInfo: [],
    slugEdited: false,
  };

  it("trims labels and accepts the supported schema enum", () => {
    const result = productFormSchema.safeParse({
      ...baseValues,
      variantOption1Label: " Size ",
      variantOption2Label: " Finish ",
      variantOption1Schema: "size",
      variantOption2Schema: "pattern",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.variantOption1Label).toBe("Size");
    expect(result.data.variantOption2Label).toBe("Finish");
    expect(result.data.variantOption2Schema).toBe("pattern");
  });

  it("rejects empty labels and unknown schema mappings", () => {
    const result = productFormSchema.safeParse({
      ...baseValues,
      variantOption1Label: " ",
      variantOption2Schema: "style",
    });

    expect(result.success).toBe(false);
  });

  it("rejects product canonical overrides outside product routes", () => {
    const result = productFormSchema.safeParse({
      ...baseValues,
      canonicalPath: "/shop/main-shoe",
    });

    expect(result.success).toBe(false);
  });

  it("includes catalog option mapping fields in product submissions", () => {
    expect(
      formatFormValuesForSubmission(
        {
          ...baseValues,
          variantOption1Label: "Pack",
          variantOption2Label: "Shade",
          variantOption1Schema: "size",
          variantOption2Schema: "color",
        },
        false,
        "option2",
        [],
      ),
    ).toMatchObject({
      variantOption1Label: "Pack",
      variantOption2Label: "Shade",
      variantOption1Schema: "size",
      variantOption2Schema: "color",
    });
  });

  it("keeps product condition as an explicit merchant-owned submission field", () => {
    expect(productFormSchema.safeParse({ ...baseValues, productCondition: "used" }).success).toBe(true);
    expect(productFormSchema.safeParse({ ...baseValues, productCondition: "open-box" }).success).toBe(false);

    expect(
      formatFormValuesForSubmission(
        {
          ...baseValues,
          productCondition: "refurbished",
        },
        false,
        "option2",
        [],
      ),
    ).toMatchObject({
      productCondition: "refurbished",
    });
  });
});
