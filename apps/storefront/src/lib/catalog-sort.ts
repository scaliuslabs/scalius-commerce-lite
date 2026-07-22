import {
  buildProductListHref,
  type ProductListFilterState,
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
            sortBy: sortSelect.value,
            page: 1,
          },
        });
      });
    });
}
