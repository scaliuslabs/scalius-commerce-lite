import { STOREFRONT_SEARCH_SORTS } from "@scalius/shared/listing-sorts";
import {
  buildProductListHref,
  type ProductListFilterState,
  type ProductListSort,
} from "./product-list-query";
import { normalizeSearchQuery } from "./search-query";

function readCanonicalFilters(
  select: HTMLSelectElement,
): ProductListFilterState {
  try {
    const parsed = JSON.parse(select.dataset.currentFilters || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          typeof value === "string" ||
          (Array.isArray(value) &&
            value.every((item) => typeof item === "string")),
      ),
    ) as ProductListFilterState;
  } catch {
    return {};
  }
}

function listedSort(value: string | undefined): ProductListSort | undefined {
  return (STOREFRONT_SEARCH_SORTS as readonly string[]).includes(value ?? "") ? value as ProductListSort : undefined;
}

/**
 * Listing view selects (the sort, and the page size when the select's name
 * is `limit`): a change reloads the listing with that choice on page one,
 * keeping the buyer's filters.
 */
export function setupCatalogSorts(): void {
  document
    .querySelectorAll<HTMLSelectElement>("[data-catalog-sort]")
    .forEach((sortSelect) => {
      if (sortSelect.dataset.sortBound === "true") return;
      sortSelect.dataset.sortBound = "true";

      sortSelect.addEventListener("change", () => {
        const currentFilters = readCanonicalFilters(sortSelect);
        const rawQuery = currentFilters.q;
        const query = normalizeSearchQuery(
          Array.isArray(rawQuery) ? rawQuery.at(-1) : rawQuery,
        );
        if (query) currentFilters.q = query;
        else delete currentFilters.q;

        window.location.href = buildProductListHref({
          pathname: sortSelect.dataset.listPathname || window.location.pathname,
          currentFilters,
          overrides: {
            [sortSelect.name === "limit" ? "limit" : "sortBy"]: sortSelect.value,
            page: 1,
          },
          // The order the listing opens in (the store's default, or relevance for a search): left out of the URL.
          defaultSort: listedSort(sortSelect.dataset.defaultSort),
        });
      });
    });
}
