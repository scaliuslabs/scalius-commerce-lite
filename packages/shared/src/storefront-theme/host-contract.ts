// What a theme may style the store's own markup by: the host CSS variables it
// may read and the hooks the store's markup carries. Sealed in the plugin
// protocol seal (plugins/contract-tables.ts), so a name never leaves and a
// list only grows; host-contract.test.ts proves the host writes each one, and
// the theme docs list them from these constants (themes.md, storefront.md).
// Everything else in the store's markup and CSS (classes, nesting, other
// custom properties) is internal and may change in any release.

/**
 * The custom properties a theme may read (`var(--primary)`): the store's
 * palette and focus ring, and the type, shape, spacing, surface and motion
 * tokens the reference themes read. The store writes every one on every
 * public page from the theme document (`buildStorefrontTokenCss`); on dark
 * pages the colours hold the dark colours.
 */
export const STOREFRONT_HOST_CSS_VARIABLES = [
  // The palette (`STOREFRONT_THEME_COLOR_KEYS`) and the focus ring made from it.
  "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
  "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--destructive-foreground", "--border", "--input", "--ring",
  // Type.
  "--theme-font-body", "--theme-font-heading", "--theme-heading-weight", "--theme-heading-tracking", "--theme-heading-leading",
  "--theme-heading-transform", "--theme-h1-weight", "--theme-section-weight",
  // Shape and size.
  "--radius", "--theme-button-radius", "--theme-control-height", "--theme-container-width",
  "--theme-gutter-phone", "--theme-gutter-tablet", "--theme-gutter-desktop", "--theme-grid-gap-phone", "--theme-grid-gap-desktop",
  "--theme-image-ratio", "--theme-image-fit",
  // Surfaces and the colour roles beyond the palette.
  "--theme-header-background", "--theme-header-foreground", "--theme-sale", "--theme-rating",
  "--theme-surface-border", "--theme-surface-shadow",
  // Motion.
  "--theme-duration-fast", "--theme-duration-base",
] as const;

/**
 * The hooks the store's own markup carries on public pages, by where they
 * are: each attribute (or, for the phone bar, selector) with the values it
 * takes (none listed: a presence attribute, or a value the store sets per
 * item such as an id or a state). The private pages (cart, drawer, checkout,
 * receipt, account) have their own sealed anatomy (private-anatomy.ts).
 */
export const STOREFRONT_HOST_HOOKS = {
  /** The buy form (storefront.md, "Styling the buy form"). */
  buyForm: {
    "data-buy-part": ["price", "options", "inputs", "purchase-options", "quantity", "actions", "status", "warranty", "stock", "variant-title"],
    "data-buy-field": ["option", "input", "quantity"],
    "data-buy-field-part": ["label", "control", "value", "error", "help", "counter", "surcharge", "decrease", "increase"],
    "data-action": ["add-to-cart", "buy-now"],
    "data-state": ["ready", "busy", "unavailable", "idle", "error"],
    "data-option-availability": ["available", "sold_out", "incompatible"],
    "data-buyer-input": [],
    "data-buyer-input-type": [],
    "data-empty": [],
    "data-stock-tone": [],
    "data-price-current": [],
    "data-price-regular": [],
    "data-price-badge": [],
  },
  /** Offers placed under the product's own (storefront.md, "Placed offers and kits"). */
  placedOffers: {
    "data-placed-offers": [],
    "data-placed-offer": [],
    "data-availability": [],
    "data-offer-part": ["title", "options", "price", "saving", "actions", "choose"],
    "data-price-current": [],
    "data-price-regular": [],
  },
  /** A kit's contents. */
  kits: {
    "data-kit-contents": [],
    "data-kit-part": ["summary", "items", "item", "title", "options", "quantity", "delivery", "unavailable", "more", "saving"],
    "data-kit-delivery": [],
  },
  /** Related products (the `recommendations` embed). */
  relatedProducts: {
    "data-recs-part": ["root", "title", "list"],
    "data-recs-reason": [],
  },
  /** The filters embed's wrapper and the numbers it carries. */
  catalogFilters: {
    "data-catalog-embed": ["filters"],
    "data-placement": ["sidebar", "bar"],
    "custom-properties": ["--catalog-filter-column", "--catalog-filter-row", "--catalog-filter-label"],
  },
  /** A buy column that stays in view: a skin marks it, the store shifts it (`--sticky-column-shift`). */
  stickyColumn: {
    "data-sticky-column": [],
    "custom-properties": ["--sticky-column-shift"],
  },
  /**
   * The store's phone bar under any header: the bar, each tab, a tab's label,
   * its icon (the store's `svg` or the theme's image) and the cart tab's
   * count, the current tab (`aria-current`), and the bar's height. Its old
   * `#mobile-tab-bar` id and `.mobile-tab` class stay in the markup but are
   * not promised.
   */
  phoneBar: {
    "data-part": ["tab-bar", "tab", "tab-label", "tab-icon", "tab-badge"],
    "aria-current": [],
    "custom-properties": ["--mobile-tabs-height"],
  },
} as const;
