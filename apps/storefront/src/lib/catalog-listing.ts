// The listing template (category, search, collection and brand pages share
// it): what the resolved theme's listing block, and a listing's own
// `listing_template`, mean for one listing, as data the catalog components
// render. Measured anatomy: SYNTHESIS.md section 2.4 and fidelity AUDIT.md
// section 0 (listing density, facet column compactness).
//
// The adapters below read the catalogue data: the category tree (`children`
// on a category, and the category-tree facet) fills sub-category pills and
// shelves, and typed attributes name each facet's display (checkboxes, a
// range, swatches or a searchable list), which catalogFacetDisplay turns
// into what the filter form renders.
import {
  STOREFRONT_LISTING_FILTER_SPECS,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_LISTING_VARIANTS,
  failedFitConditions,
  storefrontListingFiltersShown,
  type ResolvedStorefrontTheme,
  type StorefrontListingFilterSpec,
  type StorefrontListingFilterStyle,
  type StorefrontListingToolbarPiece,
} from "@scalius/shared/storefront-theme";
import type { ProductFacet } from "@/lib/api";
import type { ProductGridContext } from "@/lib/product-card-layout";
import {
  buildProductListHref,
  type ProductListFilterState,
  type ProductListSort,
} from "./product-list-query";
import { catalogSwatchPaint, type FacetDisplayValue } from "./catalog-swatch";

export { catalogSwatchPaint };

type ResolvedListing = ResolvedStorefrontTheme["blocks"]["listing"];
type ThemeGrid = ResolvedStorefrontTheme["layout"]["grid"];

export type CatalogListingLayout = keyof typeof STOREFRONT_LISTING_VARIANTS;

/** Where the facets live on computers, with the style's measured numbers. */
export interface CatalogFilterPresentation {
  style: StorefrontListingFilterStyle;
  /**
   * `sidebar`: an open column beside the results (Amazon, Daraz, Star Tech);
   * `bar`: a one-line bar of facet dropdowns over a full-width grid (Dawn,
   * Aarong); `drawer`: a Filter button opening a drawer (Target, Chaldal).
   * On phones every placement is a Filter button and a bottom sheet.
   */
  placement: StorefrontListingFilterSpec["placement"];
  /** Facet groups start open (never for bar dropdowns). */
  openByDefault: boolean;
  /** Facet dropdowns in the bar before "More filters" (bar only). */
  barFacets: number;
  /** The measured numbers as CSS custom properties (column, row pitch, label size). */
  styleVars: string;
  /** The desktop column width in px beside the results (0 without a column): card image sizes subtract it. */
  columnPx: number;
}

export interface CatalogListingPresentation {
  layout: CatalogListingLayout;
  filters: CatalogFilterPresentation;
  /** One card per grid cell, one product per row (Amazon), or the dense quick-add grid (Chaldal). */
  results: "grid" | "list" | "quick";
  /** Sub-category shelves on the plain first page, when the listing has shelves. */
  shelves: boolean;
  /** Shelves on one landing (the layout's own setting, 8 by default). */
  maxShelves: number;
  toolbar: ReadonlySet<StorefrontListingToolbarPiece>;
  phoneLayout: ResolvedListing["phoneLayout"];
  paging: ResolvedListing["paging"];
}

const LAYOUTS: Record<CatalogListingLayout, Pick<CatalogListingPresentation, "results" | "shelves">> = {
  grid: { results: "grid", shelves: false },
  list: { results: "list", shelves: false },
  shelves: { results: "grid", shelves: true },
  "quick-grid": { results: "quick", shelves: false },
};

const isLayout = (value: string): value is CatalogListingLayout => Object.hasOwn(LAYOUTS, value);
const isFilterStyle = (value: string): value is StorefrontListingFilterStyle =>
  (STOREFRONT_LISTING_FILTER_STYLES as readonly string[]).includes(value);

/** The column width catalog-listing.css gives a sidebar whose spec names none. */
const SIDEBAR_FALLBACK_COLUMN_PX = 270;

/** The measured numbers of a filter style as CSS custom properties; a null keeps the density token. */
function filterStyleVars(spec: StorefrontListingFilterSpec): string {
  return [
    spec.column !== null && `--catalog-filter-column:${spec.column}px`,
    spec.rowPitch !== null && `--catalog-filter-row:${spec.rowPitch}px`,
    spec.label !== null && `--catalog-filter-label:${spec.label}px`,
  ].filter(Boolean).join(";");
}

function filterPresentation(
  style: StorefrontListingFilterStyle,
  openByDefault: boolean,
  spec: StorefrontListingFilterSpec = STOREFRONT_LISTING_FILTER_SPECS[style],
): CatalogFilterPresentation {
  return {
    style,
    placement: spec.placement,
    // Bar dropdowns open on demand (the document schema refuses otherwise).
    openByDefault: spec.placement === "bar" ? false : openByDefault,
    barFacets: spec.barFacets ?? 0,
    styleVars: filterStyleVars(spec),
    columnPx: spec.placement === "sidebar" ? spec.column ?? SIDEBAR_FALLBACK_COLUMN_PX : 0,
  };
}

/**
 * The resolved listing block as the catalog components render it, for one
 * listing. `listingTemplate` is the category's, collection's or brand's own
 * `listing_template`: a layout (grid, list, shelves, quick-grid) or a filter
 * style (sidebar-dense, sidebar-comfortable, bar-dropdowns, drawer) that
 * overrides the theme for that listing when the store fits it (shelves need
 * a tree or collections, the quick grid the quick-add card). Anything else,
 * or null, is the theme's own listing.
 */
export function catalogListingPresentation(
  resolved: Pick<ResolvedStorefrontTheme, "facts"> & {
    blocks: Pick<ResolvedStorefrontTheme["blocks"], "listing" | "card">;
  },
  listingTemplate?: string | null,
): CatalogListingPresentation {
  const listing = resolved.blocks.listing;
  let layout: CatalogListingLayout = isLayout(listing.layout.variant) ? listing.layout.variant : "grid";
  let settings = listing.layout.settings;
  // The theme's style with the template's own numbers (Daraz's 190px column, 18px rows).
  let filters = filterPresentation(listing.filters.style, listing.filters.openByDefault, listing.filters.spec);
  const own = listingTemplate?.trim() ?? "";
  if (isLayout(own) && own !== layout) {
    const fits = failedFitConditions(STOREFRONT_LISTING_VARIANTS[own].requires, {
      facts: resolved.facts,
      blocks: { card: resolved.blocks.card.variant },
    }).length === 0;
    if (fits) {
      layout = own;
      settings = STOREFRONT_LISTING_VARIANTS[own].defaults;
    }
  } else if (isFilterStyle(own)) {
    filters = filterPresentation(own, STOREFRONT_LISTING_FILTER_SPECS[own].placement === "sidebar" || listing.filters.openByDefault);
  }
  const maxShelves = Number((settings as { maxShelves?: unknown }).maxShelves ?? 8);
  return {
    layout,
    ...LAYOUTS[layout],
    maxShelves: Number.isInteger(maxShelves) && maxShelves > 0 ? maxShelves : 8,
    filters,
    toolbar: new Set(listing.toolbar),
    phoneLayout: listing.phoneLayout,
    paging: listing.paging,
  };
}

/**
 * Which listing controls help. Sort needs two results (or a refinement to
 * undo). Filters follow the small-catalogue rule
 * (`storefrontListingFiltersShown`): at least 8 results and a facet or the
 * price range with two values, unless the buyer already refined; and the
 * store itself must reach the threshold (`storeShown`, the resolved
 * listing's `filters.shown`).
 */
export function catalogListingControls({
  total,
  refinementCount,
  facetValueCounts,
  storeShown = true,
}: {
  total: number;
  refinementCount: number;
  /** One entry per facet worth showing (its values with products; a range or the price counts 2 when it spans). */
  facetValueCounts: readonly number[];
  storeShown?: boolean;
}): { sort: boolean; filters: boolean } {
  const refined = refinementCount > 0;
  return {
    sort: total > 1 || refined,
    filters: refined || (storeShown && storefrontListingFiltersShown({ total, refinementCount, facetValueCounts })),
  };
}

// ─── Facet display types ────────────────────────────────────────────────

/**
 * How a facet renders: checkboxes; colour swatches; checkboxes with a search
 * field for long value lists (Apple Gadgets); or a min/max pair for a number
 * attribute. A typed attribute names it (the merchant's choice); option axes
 * and the brand are read from their values.
 */
export type CatalogFacetDisplay = "checkbox" | "swatch" | "search-list" | "range";
/** Value lists longer than this get a search field (Apple Gadgets: brand lists). */
export const CATALOG_FACET_SEARCH_MIN_VALUES = 12;


/**
 * The facet's display and, for swatches, each value's paint keyed by the
 * submitted value (a typed swatch value with no known colour has none).
 */
export function catalogFacetDisplay(
  facet: Pick<ProductFacet, "kind" | "display"> & { values: readonly FacetDisplayValue[] },
): { display: CatalogFacetDisplay; swatches: ReadonlyMap<string, string> } {
  const swatches = new Map<string, string>();
  const paint = () => {
    for (const value of facet.values) {
      const colour = catalogSwatchPaint(value);
      if (colour) swatches.set(value.value, colour);
    }
  };
  if (facet.kind === "attribute" || facet.display === "range") {
    if (facet.display === "swatch") paint();
    return { display: facet.display === "search_list" ? "search-list" : facet.display, swatches };
  }
  paint();
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
  // Letters of any script stay (Bangla option axes); anything else becomes
  // `_` plus its code point, so two slugs never share an id.
  return `catalog-facet-${slug.replace(/[^\p{L}\p{M}\p{N}-]/gu, (character) => `_${character.codePointAt(0)!.toString(16)}`)}`;
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
  // A range facet has no values to link (its bounds are typed in the form),
  // and category values are sub-listings, not filters.
  return facets
    .filter((facet) => facet.kind !== "category")
    .flatMap((facet) =>
      facet.values
        .filter(({ value, count }) => count > 0 && count < total && !selected(facet.slug).includes(value))
        .map(({ value, label, count }) => ({ facet, value, label, count })))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, max)
    .map(({ facet, value, label }) => ({
      label,
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

/** A shelf needs two products; a lone product joins the last shelf. */
export const CATALOG_SHELF_MIN_ITEMS = 2;

/**
 * Shelves from the listing's groups (a category's sub-categories once the
 * tree exists; a dynamic collection's categories today) over the products
 * already read for the page: no extra read. Products outside every group
 * (or alone in theirs) share a last shelf, and every product of the page
 * stays on a shelf, since the next page starts after them. Fewer than two
 * shelves is no shelf layout at all.
 */
export function catalogShelves<Item extends { categoryId?: string | null; subcategoryId?: string | null }>({
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
    // A subtree listing names the child each product sits under (a
    // grandchild's product joins its child's shelf); else its own category.
    const groupId = item.subcategoryId ?? item.categoryId;
    const shelf = groupId ? byGroup.get(groupId) : undefined;
    (shelf ?? rest).push(item);
  }
  const shelves: CatalogShelf<Item>[] = [];
  for (const group of groups) {
    const grouped = byGroup.get(group.id)!;
    if (grouped.length >= CATALOG_SHELF_MIN_ITEMS) shelves.push({ id: group.id, title: group.label, href: group.href, items: grouped });
    else rest.push(...grouped);
  }
  // Shelves past the cap join the catch-all shelf, so no product is dropped.
  const kept = rest.length > 0 || shelves.length > maxShelves ? maxShelves - 1 : maxShelves;
  for (const extra of shelves.splice(Math.max(1, kept))) rest.push(...extra.items);
  if (rest.length > 0) shelves.push({ id: "more", title: restTitle, href: null, items: rest });
  return shelves.length < 2 ? [] : shelves;
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

/** A category's published sub-categories (the category payload's `children`): pills and shelves. */
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
  return presentation.filters.placement === "sidebar" && filtersShown ? "beside-filters" : "grid";
}

// ─── Category-tree facet ────────────────────────────────────────────────

export interface CatalogCategoryLink {
  label: string;
  /** The sub-listing with the buyer's filters and search (not their page, sort or page size); empty when nothing is left. */
  href: string;
  count: number;
}

/**
 * The category-tree facet's values as links (Daraz's category list, Star
 * Tech's search pills): each opens the category page with the buyer's
 * filters and search, so the count shown is what the link lists. A category
 * with nothing left under the filters has no link.
 */
export function catalogCategoryFacetLinks(
  facet: Pick<ProductFacet, "values">,
  currentFilters: ProductListFilterState,
): CatalogCategoryLink[] {
  const carried = Object.fromEntries(
    Object.entries(currentFilters).filter(([key]) => !["page", "sortBy", "limit", "showAll"].includes(key)),
  );
  return facet.values.map(({ value, label, count }) => ({
    label,
    count,
    href: count > 0
      ? buildProductListHref({ pathname: `/categories/${encodeURIComponent(value)}`, currentFilters: carried })
      : "",
  }));
}
