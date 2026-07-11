import type {
  Product,
  ProductImage,
  ProductVariant,
  ProductVariantImageMapping,
} from "./api/types";

export type VariantImageAxis = "option1" | "option2";

const LEGACY_MARKER = /<!--variant_images:(enabled|option1|option2)-->/;

function normalizeOptionValue(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function legacyConfiguration(product: Product): {
  enabled: boolean;
  axis: VariantImageAxis;
} {
  const marker = product.metaDescription?.match(LEGACY_MARKER)?.[1];
  return {
    enabled: Boolean(marker),
    axis: marker === "option1" ? "option1" : "option2",
  };
}

function orderedOptionValues(
  variants: readonly ProductVariant[],
  axis: VariantImageAxis,
): string[] {
  const valueField = axis === "option1" ? "size" : "color";
  const primaryOrderField = axis === "option1" ? "sizeSortOrder" : "colorSortOrder";
  const secondaryOrderField = axis === "option1" ? "colorSortOrder" : "sizeSortOrder";
  const ordered = variants
    .filter((variant) => !variant.isDefault && !variant.deletedAt)
    .map((variant) => ({
      value: variant[valueField]?.trim() ?? "",
      primaryOrder: variant[primaryOrderField] ?? 0,
      secondaryOrder: variant[secondaryOrderField] ?? 0,
      createdAt: Date.parse(variant.createdAt) || 0,
      id: variant.id,
    }))
    .filter((variant) => variant.value)
    .sort((left, right) =>
      left.primaryOrder - right.primaryOrder
      || left.secondaryOrder - right.secondaryOrder
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)
    );
  const seen = new Set<string>();
  return ordered.flatMap((variant) => {
    if (seen.has(variant.value)) return [];
    seen.add(variant.value);
    return [variant.value];
  });
}

export function resolveProductVariantImageConfiguration(params: {
  product: Product;
  images: readonly ProductImage[];
  variants: readonly ProductVariant[];
  mappings: readonly ProductVariantImageMapping[];
}): {
  enabled: boolean;
  axis: VariantImageAxis;
  mappings: ProductVariantImageMapping[];
} {
  const legacy = legacyConfiguration(params.product);
  const hasExplicitConfiguration =
    typeof params.product.variantImagesEnabled === "boolean";
  const enabled = hasExplicitConfiguration
    ? params.product.variantImagesEnabled === true
    : legacy.enabled;
  const axis = hasExplicitConfiguration
    ? params.product.variantImageAxis ?? "option2"
    : legacy.axis;

  if (params.mappings.length > 0 || hasExplicitConfiguration || !legacy.enabled) {
    return { enabled, axis, mappings: [...params.mappings] };
  }

  const optionValues = orderedOptionValues(params.variants, axis);
  const images = [...params.images].sort((left, right) =>
    left.sortOrder - right.sortOrder
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.id.localeCompare(right.id)
  );
  return {
    enabled,
    axis,
    mappings: optionValues.flatMap((optionValue, index) => {
      const image = images[index];
      if (!image) return [];
      return [{
        id: `legacy:${image.id}`,
        productId: params.product.id,
        imageId: image.id,
        variantId: null,
        optionAxis: axis,
        optionValue,
        normalizedOptionValue: normalizeOptionValue(optionValue),
        sortOrder: index,
      }];
    }),
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
