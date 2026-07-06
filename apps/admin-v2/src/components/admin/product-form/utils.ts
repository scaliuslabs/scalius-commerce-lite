// src/components/admin/product-form/utils.ts
import type { ProductFormValues } from "./types";
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

/**
 * Add variant images marker to meta description
 */
export const addVariantImagesMarker = (
  metaDescription: string | null | undefined,
  enableVariantImages: boolean,
  variantImageAxis: VariantImageAxis,
): string | null => {
  const cleaned = cleanMetaDescription(metaDescription);

  if (enableVariantImages) {
    return `${cleaned || ""}<!--variant_images:${variantImageAxis}-->`;
  }

  return cleaned;
};

/**
 * Format form values for API submission
 */
export const formatFormValuesForSubmission = (
  values: ProductFormValues,
  enableVariantImages: boolean,
  variantImageAxis: VariantImageAxis,
): CreateProductInput => {
  const metaDescription = addVariantImagesMarker(
    values.metaDescription,
    enableVariantImages,
    variantImageAxis,
  );

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
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    excludeFromProductFeed: values.excludeFromProductFeed,
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
