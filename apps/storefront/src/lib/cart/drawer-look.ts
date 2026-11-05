// The cart drawer's look from the theme's `cartDrawer` block. The Layout
// paints a choice other than the default on the body (`themePaint`), so the
// drawer, which mounts in the browser after the page, reads it there: no
// attribute is the default, as every store drew it before the block.
import type { StorefrontCartDrawerBlock } from "@scalius/shared/storefront-theme";

/** The body attributes a drawer choice paints (the default paints none). */
export function cartDrawerAttributes(block: StorefrontCartDrawerBlock): Record<string, string> {
  return {
    ...(block.width === "wide" ? { "data-cart-drawer-width": "wide" } : {}),
    ...(block.recommendations === "hidden" ? { "data-cart-drawer-recommendations": "hidden" } : {}),
  };
}

/** The drawer's look as the page painted it. */
export function readCartDrawerLook(root: HTMLElement | null = typeof document === "undefined" ? null : document.body): StorefrontCartDrawerBlock {
  return {
    width: root?.dataset.cartDrawerWidth === "wide" ? "wide" : "standard",
    recommendations: root?.dataset.cartDrawerRecommendations === "hidden" ? "hidden" : "shown",
  };
}
