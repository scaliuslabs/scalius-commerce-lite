// Names the store's own browser scripts share without importing each other,
// so a page loads only the scripts it uses.

/**
 * Deferred markup (`<scalius-deferred>`, scripts/app-components.ts) entered
 * the page: the element fires this (bubbling) once its content is in place,
 * so the store's scripts bring that content up to date (a product_main
 * skin's SKU controls, components/product/scripts/product-controller.ts).
 */
export const DEFERRED_REVEAL_EVENT = "scalius-deferred-reveal";

/**
 * One of the store's own lazy scripts failed to load (a page cached before a
 * deploy): fired on the window, it makes the page's stale-asset recovery
 * (lib/inline-boot-scripts.ts) reload, unless that would lose what the buyer
 * typed, in which case the store does not fire it.
 */
export const STALE_ASSET_EVENT = "scalius-stale-asset";
