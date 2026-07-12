import type {
  Product,
  ProductImage,
  ProductVariantImageMapping,
} from "./api/types";

export type VariantImageAxis = "option1" | "option2";

function normalizeOptionValue(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

export function resolveProductVariantImageConfiguration(params: {
  product: Product;
  mappings: readonly ProductVariantImageMapping[];
}): {
  enabled: boolean;
  axis: VariantImageAxis;
  mappings: ProductVariantImageMapping[];
} {
  return {
    enabled: params.product.variantImagesEnabled === true,
    axis: params.product.variantImageAxis ?? "option2",
    mappings: [...params.mappings],
  };
}

export function resolveVariantImageId(params: {
  enabled: boolean;
  axis: VariantImageAxis;
  mappings: readonly ProductVariantImageMapping[];
  images: readonly Pick<ProductImage, "id" | "isPrimary" | "sortOrder">[];
  selectedVariantId?: string | null;
  selectedOptionValue?: string | null;
}): string | null {
  const primaryImageId = [...params.images].sort((left, right) =>
    Number(right.isPrimary) - Number(left.isPrimary)
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id)
  )[0]?.id ?? null;
  if (!params.enabled) return primaryImageId;

  const validImageIds = new Set(params.images.map((image) => image.id));
  const orderedMappings = [...params.mappings].sort((left, right) =>
    left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)
  );
  if (params.selectedVariantId) {
    const exactVariantMapping = orderedMappings.find((mapping) =>
      mapping.variantId === params.selectedVariantId
      && validImageIds.has(mapping.imageId)
    );
    if (exactVariantMapping) return exactVariantMapping.imageId;
  }

  const selectedOption = normalizeOptionValue(params.selectedOptionValue);
  if (selectedOption) {
    const optionMapping = orderedMappings.find((mapping) =>
      mapping.variantId === null
      && mapping.optionAxis === params.axis
      && normalizeOptionValue(mapping.optionValue) === selectedOption
      && validImageIds.has(mapping.imageId)
    );
    if (optionMapping) return optionMapping.imageId;
  }

  return primaryImageId;
}
