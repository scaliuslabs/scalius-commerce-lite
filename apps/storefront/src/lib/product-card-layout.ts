import type { StorefrontThemeLayout } from "@scalius/shared/storefront-theme";

/**
 * `sizes` for a product card image, matching the `.product-grid` columns
 * (theme-foundation.css): phones 1–2, tablets up to 3, desktop 2–4. Browsers
 * then pick the smallest rendition that fills the card, not a 1600px master.
 */
export function productCardImageSizes(grid: StorefrontThemeLayout["grid"]): string {
  const phone = grid.mobile === 1 ? "calc(100vw - 2rem)" : "calc(50vw - 1.5rem)";
  const tablet = `${Math.round(100 / Math.min(grid.desktop, 3))}vw`;
  const desktop = `${Math.round(100 / grid.desktop)}vw`;
  return `(max-width: 639px) ${phone}, (max-width: 1023px) ${tablet}, (min-width: 1280px) min(${desktop}, ${Math.round(1280 / grid.desktop)}px), ${desktop}`;
}
