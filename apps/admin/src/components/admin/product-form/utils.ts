// src/components/admin/product-form/utils.ts
import type { ProductFormValues } from "./types";

/**
 * Extract unique color options from variants, sorted by colorSortOrder
 */
export const extractUniqueColors = (variants: any[]): string[] => {
  // Create a map of color to its sort order
  const colorMap = new Map<string, number>();

  variants.forEach((variant) => {
    if (variant.color && !colorMap.has(variant.color)) {
      colorMap.set(variant.color, variant.colorSortOrder || 0);
    }
  });

  // Sort by sortOrder, then return just the color names
  return Array.from(colorMap.entries())
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

  const cleaned = metaDescription.replace(/<!--variant_images:enabled-->/g, "");
  return cleaned.trim() || null;
};

/**
 * Check if variant images are enabled in meta description
 */
export const hasVariantImagesEnabled = (
  metaDescription: string | null | undefined,
): boolean => {
  return metaDescription?.includes("<!--variant_images:enabled-->") || false;
};

/**
 * Add variant images marker to meta description
 */
export const addVariantImagesMarker = (
  metaDescription: string | null | undefined,
  enableVariantImages: boolean,
): string | null => {
  const cleaned = cleanMetaDescription(metaDescription);

  if (enableVariantImages) {
    return `${cleaned || ""}<!--variant_images:enabled-->`;
  }

  return cleaned;
};

/**
 * Format form values for API submission
 */
export const formatFormValuesForSubmission = (
  values: ProductFormValues,
  enableVariantImages: boolean,
) => {
  const metaDescription = addVariantImagesMarker(
    values.metaDescription,
    enableVariantImages,
  );

  // Ensure only ONE discount type is active by clearing the unused field
  const discountPercentage = values.discountType === "percentage" ? values.discountPercentage : 0;
  const discountAmount = values.discountType === "flat" ? values.discountAmount : 0;

  return {
    ...values,
    metaDescription,
    // Explicitly set discount values based on type
    discountPercentage,
    discountAmount,
    images: values.images.map((img) => ({
      ...img,
      createdAt:
        img.createdAt instanceof Date
          ? img.createdAt.toISOString()
          : img.createdAt,
    })),
    attributes:
      (values.attributes as any[])?.map(({ attributeId, value }) => ({
        attributeId,
        value,
      })) || [],
    additionalInfo: values.additionalInfo?.map((item, index) => ({
      ...item,
      sortOrder: index,
    })),
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
