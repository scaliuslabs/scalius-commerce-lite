// Names the store's own browser scripts share without importing each other,
// so a page loads only the scripts it uses.

/**
 * Deferred markup (`<scalius-deferred>`, scripts/app-components.ts) entered
 * the page: the element fires this (bubbling) once its content is in place,
 * so the store's scripts bring that content up to date (a product_main
 * skin's SKU controls, components/product/scripts/product-controller.ts).
 */
export const DEFERRED_REVEAL_EVENT = "scalius-deferred-reveal";
