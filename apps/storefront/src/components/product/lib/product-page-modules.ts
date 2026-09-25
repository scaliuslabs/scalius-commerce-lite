/**
 * Which below-the-fold modules the product page renders, in the template's
 * order (`resolved.blocks.product.below`). The theme's fit rule already
 * dropped modules the store has no data for; this drops the ones this
 * product has no data for and the ones no renderer exists for yet, so
 * nothing renders an empty box.
 */
import type {
  StorefrontBuyBoxLook,
  StorefrontProductModule,
} from "@scalius/shared/storefront-theme";
import type { Product, ProductPageContentBlock } from "@/lib/api";

export type RenderedProductModule =
  | "description"
  | "spec-table"
  | "key-attributes"
  | "about-bullets"
  | "content-blocks"
  | "warranty"
  | "reviews"
  | "related";

/** Content-block types the product page renders; others wait for their renderer. */
export const RENDERED_CONTENT_BLOCK_TYPES = new Set<ProductPageContentBlock["type"]>([
  "rich-text",
  "feature-list",
  "faq",
  "video",
  "statement",
]);

/** Most key-spec rows the key-attributes table shows (Amazon's top table). */
export const KEY_ATTRIBUTES_MAX = 8;

/**
 * Today's classic buy box and Dawn's keep the description in the info
 * column (Dawn's collapsible rows); every other template renders it full
 * width at its place in the module list, as Star Tech, Daraz and Target do.
 */
export function descriptionInInfoColumn(look: StorefrontBuyBoxLook | null): boolean {
  return look === null || look.facts === "rows";
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
  context: { look: StorefrontBuyBoxLook | null; hasRelated: boolean },
): RenderedProductModule[] {
  const attributes = product.attributes ?? [];
  const has: Partial<Record<StorefrontProductModule, boolean>> = {
    description: hasDescription(product) && !descriptionInInfoColumn(context.look),
    "spec-table": attributes.length > 0,
    "key-attributes": attributes.some((row) => row.keySpec),
    // The buy box already lists the features when its look carries them.
    "about-bullets": (product.features?.length ?? 0) > 0 && (context.look?.features ?? "none") === "none",
    "content-blocks": renderedContentBlocks(product).length > 0,
    warranty: Boolean(product.warranty),
    reviews: Boolean(product.reviews),
    related: context.hasRelated,
  };
  return below.filter((module): module is RenderedProductModule => has[module] === true);
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
