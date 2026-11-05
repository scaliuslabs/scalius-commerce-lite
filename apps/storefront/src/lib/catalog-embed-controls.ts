// Whether a listing skin's `filters` and `toolbar` embeds draw anything, and
// in which placement: one answer for the embed (CatalogEmbed.astro) and the
// skin's projection (`filters.placement`, absent when no filters show), so a
// skin never lays out a column the embed leaves empty.
import type { BuyerPriceRange, ProductFacet, RatingFacetValue } from "@/lib/api";
import { catalogFacetValueCounts, catalogRatingRows, showsCatalogPriceFilter, visibleCatalogFacets } from "@/lib/catalog-filters";
import { catalogListingControls } from "@/lib/catalog-listing";
import { countActiveProductListFilters, type ProductListFilterState } from "@/lib/product-list-query";

export interface CatalogEmbedControlsInput {
  facets: readonly ProductFacet[];
  ratingFacet: readonly RatingFacetValue[] | undefined;
  priceRange: BuyerPriceRange | undefined;
  currentFilters: ProductListFilterState;
  /** The search words, which count as no refinement. */
  query: string | null | undefined;
  total: number;
  hasReviews: boolean;
  /** The theme shows filters on listings (`blocks.listing.filters.shown`). */
  storeShown: boolean;
}

/** The listing's filter and sort controls as the embed draws them, with the facts it drew them from. */
export function catalogEmbedControls(input: CatalogEmbedControlsInput) {
  const refinementCount = countActiveProductListFilters(input.currentFilters) - (input.query ? 1 : 0);
  const shownFacets = visibleCatalogFacets(input.facets, input.currentFilters);
  const showsPrice = showsCatalogPriceFilter(input.priceRange, input.currentFilters);
  const ratingRows = catalogRatingRows(input.ratingFacet, input.currentFilters, input.hasReviews);
  const controls = catalogListingControls({
    total: input.total,
    refinementCount,
    facetValueCounts: [
      ...catalogFacetValueCounts(shownFacets, showsPrice ? input.priceRange : undefined),
      ratingRows.filter(({ count }) => count > 0).length,
    ],
    storeShown: input.storeShown,
  });
  return { controls, refinementCount, shownFacets, showsPrice, ratingRows };
}

/** The placement a skin's projection names: the embed's (a drawer draws as a sidebar there), or none when the embed draws no filters. */
export function projectedFilterPlacement(shown: boolean, placement: "sidebar" | "bar" | "drawer"): "sidebar" | "bar" | null {
  if (!shown) return null;
  return placement === "bar" ? "bar" : "sidebar";
}
