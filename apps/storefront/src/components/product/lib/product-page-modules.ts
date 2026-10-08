/**
 * Which below-the-fold modules the product page renders, in the template's
 * order (`resolved.blocks.product.below`). The theme's fit rule already
 * dropped modules the store has no data for; this drops the ones this
 * product has no data for, so nothing renders an empty box. Every module
 * reads data the page already has (the product read and its
 * recommendations, the layout's policies); `recently-viewed` is this
 * browser's own list and shows nothing until the browser has one.
 */
import {
  STOREFRONT_RENDERED_CONTENT_BLOCK_TYPES,
  type StorefrontBuyBoxLook,
  type StorefrontProductModule,
} from "@scalius/shared/storefront-theme";
import type { Product, ProductPageContentBlock, ProductRecommendations } from "@/lib/api";

/** Every module has a renderer; the type stays as the page's switch reads it. */
export type RenderedProductModule = StorefrontProductModule;

/** Content-block types the product page renders (the shared list core's store shape counts). */
export const RENDERED_CONTENT_BLOCK_TYPES = new Set<ProductPageContentBlock["type"]>(STOREFRONT_RENDERED_CONTENT_BLOCK_TYPES);

/** Similar products beside this one in the compare module (the compare page takes four). */
export const COMPARE_SIMILAR_MAX = 3;

/** Recommended products of this product's category, for comparing with it (none without a category). */
export function compareSimilarProducts(
  product: Pick<Product, "id" | "categoryId">,
  recommendations: ProductRecommendations,
): Product[] {
  if (!product.categoryId) return [];
  return recommendations.products
    .filter((candidate) => candidate.id !== product.id && candidate.categoryId === product.categoryId)
    .slice(0, COMPARE_SIMILAR_MAX);
}

/** Most key-spec rows the key-attributes table shows (Amazon's top table). */
export const KEY_ATTRIBUTES_MAX = 8;

/**
 * A buy box with `details: "buy-box"` keeps the description beside the
 * gallery; the others render it full width in the module list.
 */
export function descriptionInInfoColumn(look: StorefrontBuyBoxLook): boolean {
  return look.details === "buy-box";
}

export function renderedContentBlocks(product: Pick<Product, "contentBlocks">): ProductPageContentBlock[] {
  return (product.contentBlocks ?? []).filter((block) => RENDERED_CONTENT_BLOCK_TYPES.has(block.type));
}

function hasDescription(product: Product): boolean {
  return Boolean(product.description) ||
    (product.features?.length ?? 0) > 0 ||
    (product.additionalInfo?.length ?? 0) > 0;
}

export function productPageModules(
  below: readonly StorefrontProductModule[],
  product: Product,
  context: {
    look: StorefrontBuyBoxLook;
    hasRelated: boolean;
    /** Same-category products to compare with (`compareSimilarProducts`). */
    similar?: number;
    /** The store's published policy pages. */
    policies?: number;
  },
): RenderedProductModule[] {
  const attributes = publicSpecificationRows(product.attributes ?? []);
  const has: Record<StorefrontProductModule, boolean> = {
    description: hasDescription(product) && !descriptionInInfoColumn(context.look),
    "spec-table": attributes.length > 0,
    // Highlights add nothing the spec table or the buy box's own facts column already lists: they show only above a longer table.
    "key-attributes": context.look.facts !== "column" && attributes.some((row) => row.keySpec) && attributes.length > attributes.filter((row) => row.keySpec).length,
    // The buy box already lists the features when its look carries them.
    "about-bullets": (product.features?.length ?? 0) > 0 && context.look.features === "none",
    "content-blocks": renderedContentBlocks(product).length > 0,
    "compare-similar": (context.similar ?? 0) > 0,
    warranty: Boolean(product.warranty),
    reviews: Boolean(product.reviews),
    policies: (context.policies ?? 0) > 0,
    related: context.hasRelated,
    // Filled from this browser's list after parsing; hidden while empty.
    "recently-viewed": true,
  };
  return below.filter((module) => has[module]);
}

/** Only saved specifications buyers can read; brand comes from the published brand record. */
export function publicSpecificationRows(rows: NonNullable<Product["attributes"]>): NonNullable<Product["attributes"]> {
  return rows.filter((row) => row.name.trim() && row.value.trim() && row.name.trim().toLowerCase() !== "brand");
}

/**
 * Where the product's key features show, once: in the buy box, as Amazon's
 * "About this item" module, or at the top of the description.
 */
export function featuresPlacement(
  modules: readonly RenderedProductModule[],
  look: StorefrontBuyBoxLook,
): "buy-box" | "about" | "description" {
  if (look.features !== "none") return "buy-box";
  return modules.includes("about-bullets") ? "about" : "description";
}

/** Specification rows grouped by attribute group, in the order they arrive. */
export function groupSpecificationRows(
  rows: NonNullable<Product["attributes"]>,
): Array<{ group: string | null; rows: NonNullable<Product["attributes"]> }> {
  const groups: Array<{ group: string | null; rows: NonNullable<Product["attributes"]> }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}

export function specificationValue(row: { value: string; unit: string | null }): string {
  return row.unit ? `${row.value} ${row.unit}` : row.value;
}

/** Merchant highlights win; saved key specifications fill an otherwise empty buy-box list. */
export function buyBoxFeatures(product: Pick<Product, "features" | "attributes">, savedOnly = false): string[] {
  if (product.features?.length) return product.features;
  if (savedOnly) return [];
  return publicSpecificationRows(product.attributes ?? [])
    .filter((row) => row.keySpec)
    .slice(0, 6)
    .map((row) => `${row.name}: ${specificationValue(row)}`);
}
