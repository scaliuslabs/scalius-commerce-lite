// Core embeds in app markup (packages/plugin-sdk/docs/storefront.md "Core embeds"):
// `<scalius-embed kind="…">` where a component hands a spot back to the
// store. The host cuts the checked markup at its embeds under the unit's
// rule (`splitStorefrontEmbeds`); the page that drew the component says how
// each kind renders there (an `EmbedRenderers` map: the core component and
// its props), so an embed always renders the page's own data with the
// store's own component, scripts and words. A kind the page gives no
// renderer, or whose renderer answers null, renders nothing.

import type { StorefrontEmbedKind, StorefrontProductModuleEmbed } from "@scalius/shared/plugins/storefront-protocol";
import type { StorefrontMarkupPart } from "@scalius/shared/plugins/storefront-embeds";
import type { StorefrontProductModule } from "@scalius/shared/storefront-theme";

/** A core component and its props: what one embed renders. */
export interface EmbedRender {
  // Any Astro component (its props are checked where the renderer is written).
  component: (...args: never[]) => unknown;
  props: Record<string, unknown>;
}

/** One embed as the markup placed it: its `data-*` values and its place among the markup's embeds. */
export interface EmbedPlacement {
  data: Readonly<Record<string, string>>;
  index: number;
}

export type EmbedRenderers = Partial<Record<StorefrontEmbedKind, (embed: EmbedPlacement) => EmbedRender | null>>;

/**
 * The one table from a placeable product module's public name
 * (`STOREFRONT_PRODUCT_MODULE_EMBEDS`) to the theme's module id (the
 * template's module list and the page's renderer).
 */
export const PRODUCT_MODULE_EMBED_IDS = {
  details: "description",
  "spec_table": "spec-table",
  "key_attributes": "key-attributes",
  "about_bullets": "about-bullets",
  "content_blocks": "content-blocks",
  "compare_similar": "compare-similar",
  policies: "policies",
  "recently_viewed": "recently-viewed",
} as const satisfies Record<StorefrontProductModuleEmbed, StorefrontProductModule>;

/** The theme module a `product_module` embed names; null for any other name. */
export function productModuleOf(name: string | undefined): StorefrontProductModule | null {
  return name && Object.hasOwn(PRODUCT_MODULE_EMBED_IDS, name) ? PRODUCT_MODULE_EMBED_IDS[name as StorefrontProductModuleEmbed] : null;
}

/** The theme modules a markup's `product_module` embeds place: the page draws those there, not again below. */
export function placedProductModules(parts: readonly StorefrontMarkupPart[]): Set<StorefrontProductModule> {
  return new Set(parts.flatMap((part) => {
    const module = part.kind === "embed" && part.embed === "product_module" ? productModuleOf(part.data.name) : null;
    return module ? [module] : [];
  }));
}

const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

/**
 * The order form of a component section (`kind="order_form"`): only for a
 * product the component was given (id to handle), with its quantity cap
 * (1 to 10, 5 by default) and submit words. Ids stay unique per placement.
 */
export function orderFormEmbed(
  OrderForm: EmbedRender["component"],
  products: ReadonlyMap<string, string>,
  options: { instanceId: string; preview: boolean },
): NonNullable<EmbedRenderers["order_form"]> {
  const prefix = encodeURIComponent(options.instanceId);
  return ({ data, index }) => {
    const product = data.product?.trim() ?? "";
    const slug = PRODUCT_ID.test(product) ? products.get(product) : undefined;
    if (!slug) return null;
    const max = Number(data["max-quantity"] ?? "5");
    return {
      component: OrderForm,
      props: {
        slug,
        idPrefix: `order-${prefix}-${index}`,
        maxQuantity: Number.isInteger(max) && max >= 1 ? Math.min(max, 10) : 5,
        submitLabel: data["submit-label"]?.trim().slice(0, 60) || undefined,
        preview: options.preview,
      },
    };
  };
}
