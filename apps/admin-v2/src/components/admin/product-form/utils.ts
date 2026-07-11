// src/components/admin/product-form/utils.ts
import type {
  ProductFormValues,
  ProductVariantImageMappingFormValue,
} from "./types";
import type { CreateProductInput } from "@/lib/api-functions/products";

export type VariantImageAxis = "option1" | "option2";

const VARIANT_IMAGES_MARKER_REGEX =
  /<!--variant_images:(?:enabled|option1|option2)-->/g;

/**
 * Extract unique option values from variants, sorted by the matching sort order.
 */
export const extractUniqueVariantOptionValues = (
  variants: Array<{
    size?: string | null;
    color?: string | null;
    sizeSortOrder?: number | null;
    colorSortOrder?: number | null;
    isDefault?: boolean | null;
  }>,
  axis: VariantImageAxis,
): string[] => {
  const optionMap = new Map<string, number>();

  variants.forEach((variant) => {
    if (variant.isDefault === true) return;
    const value = (axis === "option1" ? variant.size : variant.color)?.trim();
    if (value && !optionMap.has(value)) {
      optionMap.set(
        value,
        axis === "option1"
          ? variant.sizeSortOrder || 0
          : variant.colorSortOrder || 0,
      );
    }
  });

  return Array.from(optionMap.entries())
    .sort((a, b) => a[1] - b[1])
    .map((entry) => entry[0]);
};

/**
 * Clean meta description by removing variant images marker
 */
export const cleanMetaDescription = (
  metaDescription: string | null | undefined,
): string | null => {
  if (!metaDescription) return null;

  const cleaned = metaDescription.replace(VARIANT_IMAGES_MARKER_REGEX, "");
  return cleaned.trim() || null;
};

/**
 * Check if variant images are enabled in meta description
 */
export const hasVariantImagesEnabled = (
  metaDescription: string | null | undefined,
): boolean => {
  return Boolean((metaDescription ?? "").match(VARIANT_IMAGES_MARKER_REGEX));
};

/**
 * Resolve which option axis drives variant-specific images.
 */
export const getVariantImagesAxis = (
  metaDescription: string | null | undefined,
): VariantImageAxis => {
  if (metaDescription?.includes("<!--variant_images:option1-->")) {
    return "option1";
  }
  return "option2";
};

export const resolveVariantImageAxis = (
  preferredAxis: VariantImageAxis,
  optionOneValues: readonly string[],
  optionTwoValues: readonly string[],
): VariantImageAxis => {
  if (
    preferredAxis === "option2" &&
    optionTwoValues.length === 0 &&
    optionOneValues.length > 0
  ) {
    return "option1";
  }

  if (
    preferredAxis === "option1" &&
    optionOneValues.length === 0 &&
    optionTwoValues.length > 0
  ) {
    return "option2";
  }

  return preferredAxis;
};

const normalizeMappingOptionValue = (value: string): string =>
  value.trim().toLocaleLowerCase("en-US");

/**
 * Keeps explicit image associations stable by image ID. Reordering images does
 * not change a mapping; callers opt into filling newly-unmapped option values
 * only for explicit enable/axis/add-image actions.
 */
export const reconcileVariantImageMappings = ({
  mappings,
  images,
  axis,
  optionValues,
  variantIds = [],
  fillMissing = false,
}: {
  mappings: readonly ProductVariantImageMappingFormValue[];
  images: readonly ProductFormValues["images"][number][];
  axis: VariantImageAxis;
  optionValues: readonly string[];
  variantIds?: readonly string[];
  fillMissing?: boolean;
}): ProductVariantImageMappingFormValue[] => {
  const imageIds = new Set(images.map((image) => image.id));
  const validVariantIds = new Set(variantIds);
  const canonicalOptionValueByKey = new Map(
    optionValues.map((value) => [normalizeMappingOptionValue(value), value.trim()]),
  );
  const usedImageIds = new Set<string>();

  const reconciled: ProductVariantImageMappingFormValue[] = [];
  for (const mapping of mappings) {
    if (!imageIds.has(mapping.imageId) || usedImageIds.has(mapping.imageId)) {
      continue;
    }
    if (mapping.variantId) {
      if (!validVariantIds.has(mapping.variantId)) continue;
      usedImageIds.add(mapping.imageId);
      reconciled.push({
        imageId: mapping.imageId,
        variantId: mapping.variantId,
        optionAxis: null,
        optionValue: null,
        sortOrder: mapping.sortOrder ?? 0,
      });
      continue;
    }
    if (mapping.optionAxis !== axis || !mapping.optionValue) continue;
    const canonicalOptionValue = canonicalOptionValueByKey.get(
      normalizeMappingOptionValue(mapping.optionValue),
    );
    if (!canonicalOptionValue) continue;
    usedImageIds.add(mapping.imageId);
    reconciled.push({
      imageId: mapping.imageId,
      variantId: null,
      optionAxis: axis,
      optionValue: canonicalOptionValue,
      sortOrder: mapping.sortOrder ?? 0,
    });
  }

  if (!fillMissing) return reconciled;

  const mappedOptionKeys = new Set(
    reconciled.flatMap((mapping) => mapping.optionValue
      ? [normalizeMappingOptionValue(mapping.optionValue)]
      : []),
  );
  const unusedImages = images.filter((image) => !usedImageIds.has(image.id));
  for (const optionValue of optionValues) {
    const optionKey = normalizeMappingOptionValue(optionValue);
    if (mappedOptionKeys.has(optionKey)) continue;
    const image = unusedImages.shift();
    if (!image) break;
    usedImageIds.add(image.id);
    mappedOptionKeys.add(optionKey);
    reconciled.push({
      imageId: image.id,
      variantId: null,
      optionAxis: axis,
      optionValue: optionValue.trim(),
      sortOrder: reconciled.length,
    });
  }

  return reconciled;
};

/**
 * Format form values for API submission
 */
export const formatFormValuesForSubmission = (
  values: ProductFormValues,
  enableVariantImages: boolean,
  variantImageAxis: VariantImageAxis,
  variantImageMappings: readonly ProductVariantImageMappingFormValue[],
): CreateProductInput => {
  const metaDescription = cleanMetaDescription(values.metaDescription);

  // Ensure only ONE discount type is active by clearing the unused field
  const discountPercentage =
    values.discountType === "percentage" ? values.discountPercentage : 0;
  const discountAmount =
    values.discountType === "flat" ? values.discountAmount : 0;

  return {
    name: values.name,
    description: values.description,
    price: values.price,
    categoryId: values.categoryId,
    isActive: values.isActive,
    discountType: values.discountType,
    freeDelivery: values.freeDelivery,
    metaTitle: values.metaTitle,
    metaDescription,
    canonicalPath: values.canonicalPath,
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    excludeFromProductFeed: values.excludeFromProductFeed,
    productCondition: values.productCondition,
    variantOption1Label: values.variantOption1Label,
    variantOption2Label: values.variantOption2Label,
    variantOption1Schema: values.variantOption1Schema,
    variantOption2Schema: values.variantOption2Schema,
    variantImagesEnabled: enableVariantImages,
    variantImageAxis,
    variantImageMappings: enableVariantImages
      ? variantImageMappings.map((mapping) => ({ ...mapping }))
      : [],
    discountPercentage,
    discountAmount,
    slug: values.slug,
    images: values.images.map((img) => ({
      id: img.id,
      url: img.url,
      filename: img.filename,
      size: img.size,
      createdAt:
        img.createdAt instanceof Date
          ? img.createdAt.toISOString()
          : img.createdAt,
    })),
    attributes:
      (values.attributes as Array<{ attributeId: string; value: string }>)?.map(({ attributeId, value }) => ({
        attributeId,
        value,
      })) || [],
    additionalInfo: values.additionalInfo?.map((item, index) => ({
      ...item,
      sortOrder: index,
    })) || [],
  };
};

/**
 * Generate slug from product name
 */
export const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
};
