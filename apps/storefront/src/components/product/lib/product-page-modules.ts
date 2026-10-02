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

/** Co-bought products the bundle strip shows beside this one (Amazon shows two). */
export const FREQUENTLY_BOUGHT_TOGETHER_MAX = 2;
/** Similar products beside this one in the compare module (the compare page takes four). */
export const COMPARE_SIMILAR_MAX = 3;

/**
 * Products customers bought with this one. The recommendations say
 * `also_bought` only when at least half the list is real co-purchases
 * (core catalog/recommendations.ts), and the ranking puts co-purchases first,
 * so the first half of such a list is co-bought; anything else shows none.
 */
export function frequentlyBoughtTogether(recommendations: ProductRecommendations): Product[] {
  if (recommendations.reason !== "also_bought") return [];
  const coBought = Math.ceil(recommendations.products.length / 2);
  return recommendations.products.slice(0, Math.min(FREQUENTLY_BOUGHT_TOGETHER_MAX, coBought));
}

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
 * Classic, Dawn and the bordered fashion buy box keep the description beside
 * the gallery; other templates render it full width in the module list.
 */
export function descriptionInInfoColumn(look: StorefrontBuyBoxLook | null): boolean {
  return look === null || look.facts === "rows" || look.card;
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
    look: StorefrontBuyBoxLook | null;
    hasRelated: boolean;
    /** Co-bought products (`frequentlyBoughtTogether`). */
    boughtTogether?: number;
    /** Same-category products to compare with (`compareSimilarProducts`). */
    similar?: number;
    /** The store's published policy pages. */
    policies?: number;
  },
): RenderedProductModule[] {
  const attributes = publicSpecificationRows(product.attributes ?? []);
  const has: Record<StorefrontProductModule, boolean> = {
    "frequently-bought-together": (context.boughtTogether ?? 0) > 0,
    description: hasDescription(product) && !descriptionInInfoColumn(context.look),
    "spec-table": attributes.length > 0,
    "key-attributes": attributes.some((row) => row.keySpec),
    // The buy box already lists the features when its look carries them.
    "about-bullets": (product.features?.length ?? 0) > 0 && (context.look?.features ?? "none") === "none",
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
 * Where the product's key features show, once: in the buy box (Star Tech's
 * list, Target's chips), as Amazon's "About this item" module, or at the
 * top of the description (today).
 */
export function featuresPlacement(
  modules: readonly RenderedProductModule[],
  look: StorefrontBuyBoxLook | null,
): "buy-box" | "about" | "description" {
  if (look && look.features !== "none") return "buy-box";
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
