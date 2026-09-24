// The listing template (category, search and collection pages share it):
// what the resolved theme's listing block means for one listing, as data the
// catalog components render. Measured anatomy: SYNTHESIS.md section 2.4.
//
// Today's catalogue has flat categories and untyped attributes. The adapters
// below read today's data and are where the category tree (Phase 1a:
// `children` on a category) and typed facets (Phase 1b: `display` on a
// facet) plug in without touching the components.
import type {
  ResolvedStorefrontTheme,
  StorefrontListingToolbarPiece,
} from "@scalius/shared/storefront-theme";
import type { ProductFacet } from "@/lib/api";
import type { ProductGridContext } from "@/lib/product-card-layout";
import {
  buildProductListHref,
  type ProductListFilterState,
  type ProductListSort,
} from "./product-list-query";

type ResolvedListing = ResolvedStorefrontTheme["blocks"]["listing"];
type ThemeGrid = ResolvedStorefrontTheme["layout"]["grid"];

export type CatalogListingLayout = ResolvedListing["layout"]["variant"] & (
  "sidebar-grid" | "bar-drawer" | "list" | "shelves" | "quick-grid"
);

export interface CatalogListingPresentation {
  layout: CatalogListingLayout;
  /**
   * Where the facets live: a sticky column beside the results from 1024px
   * (a bottom sheet on phones), or a drawer behind a Filter button at every
   * width with a filter bar above the results (Target, Dawn, Aarong).
   */
  filters: "sidebar" | "drawer";
  /** One card per grid cell, one product per row (Amazon), or the dense quick-add grid (Chaldal). */
  results: "grid" | "list" | "quick";
  /** Sub-category shelves on the plain first page, when the listing has shelves. */
  shelves: boolean;
  toolbar: ReadonlySet<StorefrontListingToolbarPiece>;
  phoneLayout: ResolvedListing["phoneLayout"];
  paging: ResolvedListing["paging"];
}

const LAYOUTS: Record<CatalogListingLayout, Pick<CatalogListingPresentation, "filters" | "results" | "shelves">> = {
  "sidebar-grid": { filters: "sidebar", results: "grid", shelves: false },
  "bar-drawer": { filters: "drawer", results: "grid", shelves: false },
  list: { filters: "sidebar", results: "list", shelves: false },
  shelves: { filters: "drawer", results: "grid", shelves: true },
  "quick-grid": { filters: "drawer", results: "quick", shelves: false },
};

/** The resolved listing block as the catalog components render it. */
export function catalogListingPresentation(listing: ResolvedListing): CatalogListingPresentation {
  const layout = (listing.layout.variant in LAYOUTS ? listing.layout.variant : "sidebar-grid") as CatalogListingLayout;
  return {
    layout,
    ...LAYOUTS[layout],
    toolbar: new Set(listing.toolbar),
    phoneLayout: listing.phoneLayout,
    paging: listing.paging,
  };
}

/**
 * Filtering needs something to narrow: at least this many results (a store
 * with 2 or 3 products in a category shows them, not a sidebar), unless the
 * buyer already filtered and needs the controls to undo it.
 */
export const CATALOG_FILTER_MIN_RESULTS = 4;

/**
 * Which listing controls help. Sort needs two results; filters need
 * CATALOG_FILTER_MIN_RESULTS results and a facet or price range that
 * differs between them. Either shows while a refinement is applied.
 */
export function catalogListingControls({
  total,
  refinementCount,
  facetCount,
  showsPrice,
}: {
  total: number;
  refinementCount: number;
  /** Facets worth showing (visibleCatalogFacets). */
  facetCount: number;
  showsPrice: boolean;
}): { sort: boolean; filters: boolean } {
  const refined = refinementCount > 0;
  return {
    sort: total > 1 || refined,
    filters: refined || (total >= CATALOG_FILTER_MIN_RESULTS && (facetCount > 0 || showsPrice)),
  };
}

// ─── Facet display types ────────────────────────────────────────────────

/**
 * How a facet's values render: checkboxes; colour swatches; or checkboxes
 * with a search field for long value lists (Apple Gadgets). Typed
 * attributes (Phase 1b) name it; today it is read from the values.
 */
export type CatalogFacetDisplay = "checkbox" | "swatch" | "search-list";
/** Value lists longer than this get a search field (Apple Gadgets: brand lists). */
export const CATALOG_FACET_SEARCH_MIN_VALUES = 12;

/**
 * Colour words merchants use as values, with the swatch they paint. A facet
 * shows swatches only when every value is one of them, so a swatch never
 * guesses: "Rose Gold" or a Bangla name keeps the checkbox list.
 */
const SWATCH_COLOURS: Record<string, string> = {
  black: "#111111",
  white: "#ffffff",
  "off white": "#f4f1e8",
  cream: "#f3e9d2",
  ivory: "#fffff0",
  beige: "#d9c7a7",
  grey: "#8a8a8a",
  gray: "#8a8a8a",
  silver: "#c0c0c0",
  gold: "#c9a227",
  red: "#c62828",
  maroon: "#6d1a1f",
  pink: "#e88fb0",
  orange: "#ef7d22",
  yellow: "#f2c511",
  green: "#2e7d32",
  olive: "#6b6b2a",
  teal: "#0f7c7c",
  blue: "#1e5bc6",
  "sky blue": "#79b8e8",
  navy: "#1b2a4a",
  purple: "#6a3fa0",
  brown: "#6f4a2f",
  multicolor: "conic-gradient(#c62828, #f2c511, #2e7d32, #1e5bc6, #6a3fa0, #c62828)",
  multicolour: "conic-gradient(#c62828, #f2c511, #2e7d32, #1e5bc6, #6a3fa0, #c62828)",
};

const colourKey = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** The facet's display and, for swatches, each value's paint. */
export function catalogFacetDisplay(
  facet: Pick<ProductFacet, "values"> & { display?: CatalogFacetDisplay },
): { display: CatalogFacetDisplay; swatches: ReadonlyMap<string, string> } {
  const swatches = new Map<string, string>();
  if (facet.display && facet.display !== "swatch") return { display: facet.display, swatches };
  for (const { value } of facet.values) {
    const paint = SWATCH_COLOURS[colourKey(value)];
    if (paint) swatches.set(value, paint);
  }
  if (facet.values.length > 0 && swatches.size === facet.values.length) return { display: "swatch", swatches };
  swatches.clear();
  return {
    display: facet.values.length > CATALOG_FACET_SEARCH_MIN_VALUES ? "search-list" : "checkbox",
    swatches,
  };
}

// ─── Toolbar chips ──────────────────────────────────────────────────────

export interface CatalogAspectChip {
  slug: string;
  label: string;
  /** Values of this facet the buyer ticked. */
  selectedCount: number;
  /** The facet group in the filter form (CatalogFilters `facetAnchors`). */
  anchor: string;
}

/** The id of a facet's group in the filter form, for aspect chips to open. */
export function catalogFacetAnchor(slug: string): string {
  return `catalog-facet-${slug.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

/**
 * eBay's phone chips: one per facet the filter form shows (then Price), so a
 * tap opens the sheet at that facet. Nothing without a facet worth showing.
 */
export function catalogAspectChips(
  facets: ReadonlyArray<Pick<ProductFacet, "slug" | "name"> & { selectedCount: number }>,
  price: { shown: boolean; applied: boolean },
): CatalogAspectChip[] {
  if (facets.length === 0) return [];
  const chips = facets.map((facet) => ({
    slug: facet.slug,
    label: facet.name,
    selectedCount: facet.selectedCount,
    anchor: catalogFacetAnchor(facet.slug),
  }));
  if (price.shown) {
    chips.push({ slug: "price", label: "Price", selectedCount: price.applied ? 1 : 0, anchor: "catalog-facet-price" });
  }
  return chips;
}

export interface CatalogFilterLink {
  label: string;
  href: string;
  /** The filter is applied; the link removes it. */
  active: boolean;
}

/**
 * Target's "popular filters": one-tap links to the facet values that match
 * the most results without matching all of them (a value every product has
 * narrows nothing). Plain links, so they work without JavaScript.
 */
export function catalogPopularFilters({
  facets,
  currentFilters,
  pathname,
  defaultSort,
  total,
  max = 6,
}: {
  facets: readonly ProductFacet[];
  currentFilters: ProductListFilterState;
  pathname: string;
  defaultSort: ProductListSort;
  total: number;
  max?: number;
}): CatalogFilterLink[] {
  const selected = (slug: string) => {
    const value = currentFilters[slug];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  };
  return facets
    .flatMap((facet) =>
      facet.values
        .filter(({ value, count }) => count > 0 && count < total && !selected(facet.slug).includes(value))
        .map(({ value, count }) => ({ facet, value, count })))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, max)
    .map(({ facet, value }) => ({
      label: value,
      active: false,
      href: buildProductListHref({
        pathname,
        currentFilters,
        overrides: { [facet.slug]: [...selected(facet.slug), value], page: null },
        defaultSort,
      }),
    }));
}

/** The shopping switches as quick chips in the filter bar (Target's fulfilment chips). */
export function catalogQuickFilters({
  currentFilters,
  pathname,
  defaultSort,
}: {
  currentFilters: ProductListFilterState;
  pathname: string;
  defaultSort: ProductListSort;
}): CatalogFilterLink[] {
  return [
    { name: "hasDiscount", label: "On sale" },
    { name: "freeDelivery", label: "Free delivery" },
  ].map(({ name, label }) => {
    const active = currentFilters[name] === "true";
    return {
      label,
      active,
      href: buildProductListHref({
        pathname,
        currentFilters,
        overrides: { [name]: active ? null : "true", page: null },
        defaultSort,
      }),
    };
  });
}

// ─── Shelves and sub-category links ─────────────────────────────────────

export interface CatalogListingLink {
  id: string;
  label: string;
  href: string;
}

export interface CatalogShelf<Item> {
  id: string;
  title: string;
  /** "View all": the shelf's own indexable listing; null for the catch-all shelf. */
  href: string | null;
  items: Item[];
}

/** Aarong shows about ten products per shelf and at most eight shelves. */
export const CATALOG_SHELF_ITEMS = 10;

/**
 * Shelves from the listing's groups (a category's sub-categories once the
 * tree exists; a dynamic collection's categories today) over the products
 * already read for the page: no extra read. Products outside every group
 * share a last shelf. Fewer than two shelves is no shelf layout at all.
 */
export function catalogShelves<Item extends { categoryId?: string | null }>({
  groups,
  items,
  maxShelves,
  restTitle,
}: {
  groups: readonly CatalogListingLink[];
  items: readonly Item[];
  maxShelves: number;
  restTitle: string;
}): CatalogShelf<Item>[] {
  const byGroup = new Map(groups.map((group) => [group.id, [] as Item[]]));
  const rest: Item[] = [];
  for (const item of items) {
    const shelf = item.categoryId ? byGroup.get(item.categoryId) : undefined;
    (shelf ?? rest).push(item);
  }
  const shelves: CatalogShelf<Item>[] = groups
    .filter((group) => byGroup.get(group.id)!.length > 0)
    .map((group) => ({ id: group.id, title: group.label, href: group.href, items: byGroup.get(group.id)! }));
  // Shelves past the cap join the catch-all shelf, so no product is dropped.
  const kept = rest.length > 0 || shelves.length > maxShelves ? maxShelves - 1 : maxShelves;
  for (const extra of shelves.splice(Math.max(1, kept))) rest.push(...extra.items);
  if (rest.length > 0) shelves.push({ id: "more", title: restTitle, href: null, items: rest });
  if (shelves.length < 2) return [];
  return shelves.map((shelf) => ({ ...shelf, items: shelf.items.slice(0, CATALOG_SHELF_ITEMS) }));
}

/** Category summaries (a collection's categories) as sub-listing links. */
export function catalogCategoryLinks(
  categories: ReadonlyArray<{ id: string; name: string; slug: string }> | undefined,
): CatalogListingLink[] {
  return (categories ?? []).map((category) => ({
    id: category.id,
    label: category.name,
    href: `/categories/${encodeURIComponent(category.slug)}`,
  }));
}

/**
 * A category's sub-categories. Categories are flat today, so this reads
 * nothing; when the category tree lands (Phase 1a) the category payload's
 * `children` fill the sub-category pills and shelves with no page change.
 */
export function catalogChildLinks(category: unknown): CatalogListingLink[] {
  const children = category && typeof category === "object" ? (category as { children?: unknown }).children : undefined;
  if (!Array.isArray(children)) return [];
  return catalogCategoryLinks(children.filter((child): child is { id: string; name: string; slug: string } =>
    Boolean(child) &&
    typeof child === "object" &&
    typeof (child as { id?: unknown }).id === "string" &&
    typeof (child as { name?: unknown }).name === "string" &&
    typeof (child as { slug?: unknown }).slug === "string"));
}

// ─── Result grids ───────────────────────────────────────────────────────

/**
 * Chaldal's quick-add grid: 3 columns of about 118px on phones and 6 of
 * about 194px on a laptop, whatever the density.
 */
export function quickGridSpec(grid: ThemeGrid): ThemeGrid {
  return {
    ...grid,
    cardMin: { phone: "6.5rem", tablet: "8.5rem", desktop: "11rem" },
    gap: { phone: "0.5rem", desktop: "0.75rem" },
  };
}

/**
 * `sizes` for a list row's photo (theme-listing.css `--listing-row-media`:
 * 120px in a narrow list, 224px from the tablet step). Rows never need more.
 */
export const LIST_ROW_IMAGE_SIZES = "(max-width: 639px) 120px, 224px";

/** The image context of a card beside a sidebar or across the page. */
export function catalogCardContext(presentation: Pick<CatalogListingPresentation, "filters">, filtersShown: boolean): ProductGridContext {
  return presentation.filters === "sidebar" && filtersShown ? "beside-filters" : "grid";
}
