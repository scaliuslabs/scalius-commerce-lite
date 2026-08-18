import type { BuyerAvailabilityBand } from "./buyer-availability";
import { resolveBuyerAvailabilityBand } from "./buyer-availability";
import { resolveCatalogDiscoveryImageUrl } from "./catalog-discovery-media";
import {
  calculateCatalogFeedDiscountedAmount,
  formatCatalogFeedAmount,
  isCatalogFeedSalePrice,
  isPositiveCatalogFeedAmount,
} from "./catalog-feed-money";
import { htmlToPlainText } from "./html-sanitize";
import {
  normalizeSavedProductCondition,
  type ProductCondition,
} from "./product-condition";
import { normalizeResourceCanonicalPath } from "./seo-canonical";

export const CATALOG_FEED_MAX_PRODUCTS_PER_PROJECTION = 100;
export const CATALOG_FEED_MAX_VARIANTS_PER_PRODUCT = 250;
export const CATALOG_FEED_MAX_ATTRIBUTES_PER_PRODUCT = 250;
export const CATALOG_FEED_MAX_OPTIONS_PER_VARIANT = 10;
export const CATALOG_FEED_MAX_REPORTED_OMISSIONS = 250;

export const CATALOG_FEED_IMAGE_OPTIONS = {
  width: 1200,
  quality: 90,
  format: "auto",
  fit: "scale-down",
} as const;

export type CatalogFeedFormat = "google" | "meta";
export type CatalogFeedVariantStrategy = "products" | "variants";
export type CatalogFeedAvailability = "in_stock" | "out_of_stock";
export type CatalogFeedStandardAttributeName =
  | "size"
  | "color"
  | "material"
  | "pattern"
  | "gender"
  | "age_group";
export type CatalogFeedOptionStandardMapping =
  | "size"
  | "color"
  | "material"
  | "pattern"
  | "none";

export interface CatalogFeedImageTransformOptions {
  readonly width: 1200;
  readonly quality: 90;
  readonly format: "auto";
  readonly fit: "scale-down";
}

export type CatalogFeedImageTransform = (
  source: string,
  options: CatalogFeedImageTransformOptions,
) => string | null | undefined;

export interface CatalogFeedSelectedOptionInput {
  name: string;
  value: string;
  standardMapping: CatalogFeedOptionStandardMapping;
}

export interface CatalogFeedVariantInput {
  id: string;
  sku?: string | null;
  optionCombinationKey?: string | null;
  imageId?: string | null;
  imageUrl?: string | null;
  selectedOptions?: readonly CatalogFeedSelectedOptionInput[];
  price: number;
  stock: number;
  reservedStock?: number | null;
  availabilityBand?: BuyerAvailabilityBand;
  isDefault?: boolean;
  trackInventory?: boolean;
  barcode?: string | null;
  barcodeType?: string | null;
  discountType?: "percentage" | "flat" | null;
  discountPercentage?: number | null;
  discountAmount?: number | null;
  deletedAt?: string | null;
}

export interface CatalogFeedAttributeInput {
  name: string;
  value: string;
}

export interface CatalogFeedProductInput {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  price: number;
  discountType?: "percentage" | "flat" | null;
  discountPercentage?: number | null;
  discountAmount?: number | null;
  freeDelivery?: boolean;
  isActive?: boolean;
  availableForSale?: boolean;
  excludeFromProductFeed?: boolean;
  hasVariants?: boolean;
  imageUrl?: string | null;
  canonicalPath?: string | null;
  productCondition?: string | null;
  category?: {
    slug: string;
    name: string;
  } | null;
  attributes?: readonly CatalogFeedAttributeInput[];
  variants?: readonly CatalogFeedVariantInput[];
}

export interface CatalogFeedProjectionPolicy {
  variantStrategy: CatalogFeedVariantStrategy;
  includeUnavailableProducts: boolean;
}

export interface ProjectCatalogFeedRowsInput {
  products: readonly CatalogFeedProductInput[];
  storefrontBaseUrl: string;
  currencyCode: string;
  policy: CatalogFeedProjectionPolicy;
  transformImageUrl?: CatalogFeedImageTransform;
  maxReportedOmissions?: number;
}

export interface CatalogFeedRowPricing {
  currencyCode: string;
  originalAmount: number;
  currentAmount: number;
  price: string;
  salePrice: string | null;
  currentPrice: string;
}

export interface CatalogFeedRow {
  kind: "product" | "variant";
  productId: string;
  variantId: string | null;
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  availability: {
    canonical: CatalogFeedAvailability;
    google: CatalogFeedAvailability;
    meta: "in stock" | "out of stock";
  };
  condition: ProductCondition | null;
  pricing: CatalogFeedRowPricing;
  brand: string | null;
  gtin: string | null;
  identifierExists: "no" | null;
  itemGroupId: string | null;
  itemGroupTitle: string | null;
  variantOptions: Array<{ name: string; value: string }>;
  googleProductCategory: string | null;
  facebookProductCategory: string | null;
  productType: string | null;
  standardAttributes: Array<{
    name: CatalogFeedStandardAttributeName;
    value: string;
  }>;
  shipping: {
    country: "BD";
    service: "Standard";
    price: string;
  } | null;
}

export type CatalogFeedOmissionReason =
  | "excluded_from_product_feed"
  | "inactive_product"
  | "unavailable_product"
  | "unavailable_variant"
  | "unresolved_variant_shape"
  | "missing_image"
  | "non_positive_price"
  | "input_bounds_exceeded";

export interface CatalogFeedRowOmission {
  productId: string;
  variantId: string | null;
  reason: CatalogFeedOmissionReason;
}

export interface CatalogFeedRowProjection {
  rows: CatalogFeedRow[];
  omissions: CatalogFeedRowOmission[];
  omissionsTruncated: boolean;
}

interface CatalogFeedTaxonomy {
  googleCategory: string;
  facebookCategory: string;
}

const CATALOG_FEED_TAXONOMY_BY_CATEGORY_SLUG: Readonly<
  Record<string, CatalogFeedTaxonomy>
> = {
  medicine: {
    googleCategory: "Health & Beauty > Health Care",
    facebookCategory: "Health & Beauty > Health Care",
  },
  "vitamins-supplements": {
    googleCategory: "Health & Beauty > Health Care > Vitamins & Supplements",
    facebookCategory: "Health & Beauty > Vitamins & Supplements",
  },
  "personal-care": {
    googleCategory: "Health & Beauty > Personal Care",
    facebookCategory: "Health & Beauty > Personal Care",
  },
  "skin-care": {
    googleCategory: "Health & Beauty > Personal Care > Cosmetics > Skin Care",
    facebookCategory: "Health & Beauty > Skin Care",
  },
  "hair-care": {
    googleCategory: "Health & Beauty > Personal Care > Hair Care",
    facebookCategory: "Health & Beauty > Hair Care",
  },
  "baby-care": {
    googleCategory: "Baby & Toddler > Baby Health",
    facebookCategory: "Baby Products",
  },
  "first-aid": {
    googleCategory: "Health & Beauty > Health Care > First Aid",
    facebookCategory: "Health & Beauty > Health Care",
  },
  "medical-supplies": {
    googleCategory: "Health & Beauty > Health Care > Medical Supplies",
    facebookCategory: "Health & Beauty > Health Care",
  },
  nutrition: {
    googleCategory:
      "Food, Beverages & Tobacco > Food Items > Nutrition Bars & Drinks",
    facebookCategory: "Health & Beauty > Vitamins & Supplements",
  },
  "beauty-products": {
    googleCategory: "Health & Beauty > Personal Care > Cosmetics",
    facebookCategory: "Health & Beauty > Beauty",
  },
  electronics: {
    googleCategory: "Electronics",
    facebookCategory: "Electronics & Accessories",
  },
  "fitness-equipment": {
    googleCategory: "Sporting Goods > Exercise & Fitness",
    facebookCategory: "Sporting Goods > Fitness & Exercise",
  },
};

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function taxonomyForCategory(
  categorySlug: string | null | undefined,
): CatalogFeedTaxonomy | null {
  const slug = normalizedText(categorySlug)?.toLowerCase();
  return slug ? CATALOG_FEED_TAXONOMY_BY_CATEGORY_SLUG[slug] ?? null : null;
}

function hasCustomerOption(variant: CatalogFeedVariantInput): boolean {
  return Boolean(variant.optionCombinationKey?.trim());
}

function activePersistedVariants(
  variants: readonly CatalogFeedVariantInput[],
): CatalogFeedVariantInput[] {
  return variants.filter((variant) => !variant.deletedAt && variant.id !== "default");
}

function resolveBuyerVariants(
  variants: readonly CatalogFeedVariantInput[],
):
  | { mode: "simple"; variants: CatalogFeedVariantInput[] }
  | { mode: "optioned"; variants: CatalogFeedVariantInput[] }
  | { mode: "unavailable" | "ambiguous"; variants: [] } {
  const activeVariants = activePersistedVariants(variants);
  const activeNonDefaultVariants = activeVariants.filter(
    (variant) => !variant.isDefault,
  );
  const optionVariants = activeVariants.filter(
    (variant) => !variant.isDefault && hasCustomerOption(variant),
  );

  if (optionVariants.length > 0) {
    if (activeNonDefaultVariants.some((variant) => !hasCustomerOption(variant))) {
      return { mode: "ambiguous", variants: [] };
    }
    return { mode: "optioned", variants: optionVariants };
  }

  if (
    activeVariants.length === 1 &&
    activeVariants[0]?.isDefault === true &&
    !hasCustomerOption(activeVariants[0])
  ) {
    return { mode: "simple", variants: [activeVariants[0]] };
  }

  return {
    mode: activeVariants.length === 0 ? "unavailable" : "ambiguous",
    variants: [],
  };
}

function variantIsAvailable(variant: CatalogFeedVariantInput): boolean {
  const availabilityBand =
    variant.availabilityBand ??
    resolveBuyerAvailabilityBand({
      stock: variant.stock,
      reservedStock: variant.reservedStock,
      trackInventory: variant.trackInventory,
      lowStockThreshold: null,
    });
  return availabilityBand !== "out_of_stock";
}

function productAvailability(
  product: CatalogFeedProductInput,
): CatalogFeedAvailability {
  return product.isActive === false || product.availableForSale === false
    ? "out_of_stock"
    : "in_stock";
}

function variantAvailability(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput,
): CatalogFeedAvailability {
  return product.isActive === false || !variantIsAvailable(variant)
    ? "out_of_stock"
    : "in_stock";
}

function rowAvailability(availability: CatalogFeedAvailability) {
  return {
    canonical: availability,
    google: availability,
    meta: availability === "in_stock" ? "in stock" as const : "out of stock" as const,
  };
}

function imageLink(
  source: string | null | undefined,
  input: ProjectCatalogFeedRowsInput,
): string | null {
  return resolveCatalogDiscoveryImageUrl(source, input.storefrontBaseUrl, {
    transformImageUrl: input.transformImageUrl
      ? (imageUrl) =>
        input.transformImageUrl!(imageUrl, CATALOG_FEED_IMAGE_OPTIONS)
      : undefined,
  });
}

function productImageLink(
  product: CatalogFeedProductInput,
  input: ProjectCatalogFeedRowsInput,
): string | null {
  return imageLink(product.imageUrl, input);
}

function variantImageLink(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput,
  input: ProjectCatalogFeedRowsInput,
): string | null {
  return (
    (variant.imageId ? imageLink(variant.imageUrl, input) : null) ??
    productImageLink(product, input)
  );
}

function pricingForRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
  currencyCode: string,
): CatalogFeedRowPricing | null {
  const originalAmount = variant?.price ?? product.price;
  const variantHasDiscount = Boolean(
    variant && (
      (variant.discountType === "percentage" &&
        (variant.discountPercentage ?? 0) > 0) ||
      (variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0)
    ),
  );
  const discount = variantHasDiscount && variant ? variant : product;
  const discountedAmount = calculateCatalogFeedDiscountedAmount(
    originalAmount,
    discount.discountType,
    discount.discountPercentage,
    discount.discountAmount,
    currencyCode,
  );

  if (
    !isPositiveCatalogFeedAmount(originalAmount, currencyCode) ||
    !isPositiveCatalogFeedAmount(discountedAmount, currencyCode)
  ) {
    return null;
  }

  const original = formatCatalogFeedAmount(originalAmount, currencyCode);
  const discounted = formatCatalogFeedAmount(discountedAmount, currencyCode);
  if (original === null || discounted === null) return null;

  const hasSale = isCatalogFeedSalePrice(
    originalAmount,
    discountedAmount,
    currencyCode,
  );
  const price = `${original} ${currencyCode}`;
  const salePrice = hasSale ? `${discounted} ${currencyCode}` : null;

  return {
    currencyCode,
    originalAmount,
    currentAmount: hasSale ? discountedAmount : originalAmount,
    price,
    salePrice,
    currentPrice: salePrice ?? price,
  };
}

function supportedVariantGtin(
  variant: CatalogFeedVariantInput | undefined,
): string | null {
  const barcode = normalizedText(variant?.barcode);
  if (!barcode) return null;
  return ["ean13", "upc", "isbn", "gtin"].includes(variant?.barcodeType ?? "")
    ? barcode
    : null;
}

function gtinForRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
): string | null {
  if (variant) return supportedVariantGtin(variant);
  const resolution = resolveBuyerVariants(product.variants ?? []);
  return resolution.mode === "simple"
    ? supportedVariantGtin(resolution.variants[0])
    : null;
}

function titleForRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
): string {
  if (!variant) return product.name;
  const labels = (variant.selectedOptions ?? []).map(
    (option) => `${option.name}: ${option.value}`,
  );
  return labels.length > 0
    ? `${product.name} - ${labels.join(" / ")}`
    : product.name;
}

function linkForRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
  storefrontBaseUrl: string,
): string {
  const productPath =
    normalizeResourceCanonicalPath("product", product.canonicalPath) ??
    `/products/${product.slug}`;
  const link = new URL(productPath, `${storefrontBaseUrl}/`);
  if (variant) link.searchParams.set("variant", variant.id);
  return link.toString();
}

function standardAttributesForRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
): CatalogFeedRow["standardAttributes"] {
  const standardAttributes: CatalogFeedRow["standardAttributes"] = [];

  if (variant) {
    const emitted = new Set<CatalogFeedOptionStandardMapping>();
    for (const option of variant.selectedOptions ?? []) {
      const value = normalizedText(option.value);
      if (
        !value ||
        option.standardMapping === "none" ||
        emitted.has(option.standardMapping)
      ) {
        continue;
      }
      emitted.add(option.standardMapping);
      standardAttributes.push({ name: option.standardMapping, value });
    }
  }

  for (const attribute of product.attributes ?? []) {
    const name = attribute.name.toLowerCase();
    if (!variant && (name === "color" || name === "colour")) {
      standardAttributes.push({ name: "color", value: attribute.value });
    } else if (!variant && name === "size") {
      standardAttributes.push({ name: "size", value: attribute.value });
    } else if (name === "material") {
      standardAttributes.push({ name: "material", value: attribute.value });
    } else if (name === "gender") {
      standardAttributes.push({ name: "gender", value: attribute.value });
    } else if (name === "age_group" || name === "age group") {
      standardAttributes.push({ name: "age_group", value: attribute.value });
    } else if (name === "pattern") {
      standardAttributes.push({ name: "pattern", value: attribute.value });
    }
  }

  return standardAttributes;
}

function buildRow(
  product: CatalogFeedProductInput,
  variant: CatalogFeedVariantInput | null,
  availability: CatalogFeedAvailability,
  input: ProjectCatalogFeedRowsInput,
): CatalogFeedRow | "missing_image" | "non_positive_price" {
  const image = variant
    ? variantImageLink(product, variant, input)
    : productImageLink(product, input);
  if (!image) return "missing_image";

  const pricing = pricingForRow(product, variant, input.currencyCode);
  if (!pricing) return "non_positive_price";

  const brand = normalizedText(
    product.attributes?.find(
      (attribute) => attribute.name.toLowerCase() === "brand",
    )?.value,
  );
  const gtin = gtinForRow(product, variant);
  const taxonomy = taxonomyForCategory(product.category?.slug);
  const itemGroupId = variant || product.hasVariants ? product.id : null;
  const zeroShippingAmount = product.freeDelivery
    ? formatCatalogFeedAmount(0, input.currencyCode)
    : null;

  return {
    kind: variant ? "variant" : "product",
    productId: product.id,
    variantId: variant?.id ?? null,
    id: variant
      ? normalizedText(variant.sku) ?? variant.id
      : product.id,
    title: titleForRow(product, variant),
    description: htmlToPlainText(product.description) || product.name,
    link: linkForRow(product, variant, input.storefrontBaseUrl),
    imageLink: image,
    availability: rowAvailability(availability),
    condition: normalizeSavedProductCondition(product.productCondition),
    pricing,
    brand,
    gtin,
    identifierExists: !brand && !gtin ? "no" : null,
    itemGroupId,
    itemGroupTitle: variant
      ? product.name.trim().slice(0, 150) || product.name
      : null,
    variantOptions: variant
      ? (variant.selectedOptions ?? []).map((option) => ({
        name: option.name.slice(0, 250),
        value: option.value.slice(0, 250),
      }))
      : [],
    googleProductCategory: taxonomy?.googleCategory ?? null,
    facebookProductCategory: taxonomy?.facebookCategory ?? null,
    productType: product.category?.name.trim()
      ? product.category.name
      : null,
    standardAttributes: standardAttributesForRow(product, variant),
    shipping: product.freeDelivery && zeroShippingAmount !== null
      ? {
        country: "BD",
        service: "Standard",
        price: `${zeroShippingAmount} ${input.currencyCode}`,
      }
      : null,
  };
}

function maxReportedOmissions(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("maxReportedOmissions must be a non-negative integer.");
  }
  return Math.min(value, CATALOG_FEED_MAX_REPORTED_OMISSIONS);
}

export function projectCatalogFeedRows(
  input: ProjectCatalogFeedRowsInput,
): CatalogFeedRowProjection {
  if (input.products.length > CATALOG_FEED_MAX_PRODUCTS_PER_PROJECTION) {
    throw new RangeError(
      `Catalog feed projection accepts at most ${CATALOG_FEED_MAX_PRODUCTS_PER_PROJECTION} products.`,
    );
  }

  const rows: CatalogFeedRow[] = [];
  const omissions: CatalogFeedRowOmission[] = [];
  const omissionLimit = maxReportedOmissions(input.maxReportedOmissions);
  let omissionsTruncated = false;

  const omit = (
    productId: string,
    variantId: string | null,
    reason: CatalogFeedOmissionReason,
  ) => {
    if (omissions.length < omissionLimit) {
      omissions.push({ productId, variantId, reason });
    } else {
      omissionsTruncated = true;
    }
  };

  for (const product of input.products) {
    const variants = product.variants ?? [];
    const attributes = product.attributes ?? [];
    if (
      variants.length > CATALOG_FEED_MAX_VARIANTS_PER_PRODUCT ||
      attributes.length > CATALOG_FEED_MAX_ATTRIBUTES_PER_PRODUCT ||
      variants.some(
        (variant) =>
          (variant.selectedOptions?.length ?? 0) >
            CATALOG_FEED_MAX_OPTIONS_PER_VARIANT,
      )
    ) {
      omit(product.id, null, "input_bounds_exceeded");
      continue;
    }

    if (product.excludeFromProductFeed) {
      omit(product.id, null, "excluded_from_product_feed");
      continue;
    }
    if (product.isActive === false) {
      omit(product.id, null, "inactive_product");
      continue;
    }

    if (input.policy.variantStrategy === "products") {
      const availability = productAvailability(product);
      if (
        !input.policy.includeUnavailableProducts &&
        availability === "out_of_stock"
      ) {
        omit(product.id, null, "unavailable_product");
        continue;
      }
      const row = buildRow(product, null, availability, input);
      if (typeof row === "string") {
        omit(product.id, null, row);
      } else {
        rows.push(row);
      }
      continue;
    }

    const resolution = resolveBuyerVariants(variants);
    if (resolution.mode === "optioned") {
      for (const variant of resolution.variants) {
        const availability = variantAvailability(product, variant);
        if (
          !input.policy.includeUnavailableProducts &&
          availability === "out_of_stock"
        ) {
          omit(product.id, variant.id, "unavailable_variant");
          continue;
        }
        const row = buildRow(product, variant, availability, input);
        if (typeof row === "string") {
          omit(product.id, variant.id, row);
        } else {
          rows.push(row);
        }
      }
      continue;
    }

    if (product.hasVariants) {
      omit(product.id, null, "unresolved_variant_shape");
      continue;
    }

    const availability = productAvailability(product);
    if (
      !input.policy.includeUnavailableProducts &&
      availability === "out_of_stock"
    ) {
      omit(product.id, null, "unavailable_product");
      continue;
    }
    const row = buildRow(product, null, availability, input);
    if (typeof row === "string") {
      omit(product.id, null, row);
    } else {
      rows.push(row);
    }
  }

  return { rows, omissions, omissionsTruncated };
}

/** Exact UTF-8 size of the stable JSON representation used by bounded previews. */
export function catalogFeedRowUtf8Bytes(row: CatalogFeedRow): number {
  return new TextEncoder().encode(JSON.stringify(row)).byteLength;
}

export function catalogFeedRowsUtf8Bytes(
  rows: readonly CatalogFeedRow[],
): number {
  return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
}
