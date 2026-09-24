import type { BuyerPriceRange, ProductFacet } from "@/lib/api";
import { createApiUrl } from "@/lib/api/transport";
import { navigateToCatalogFilterSearch } from "./catalog-filter-dialog";
import type { ProductListFilterState } from "./product-list-query";

const FACET_VALUE_PREVIEW = 10;

function selectedValues(currentFilters: ProductListFilterState, key: string): string[] {
  const value = currentFilters[key];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Facets worth showing: at least two values that still match products (a
 * single-value facet filters nothing), or any facet the buyer already uses so
 * the selection can be undone. Values beyond the first ten are folded.
 */
export function visibleCatalogFacets(
  facets: readonly ProductFacet[],
  currentFilters: ProductListFilterState,
) {
  return facets
    .map((facet) => {
      const selected = new Set(selectedValues(currentFilters, facet.slug));
      const values = facet.values.map((value) => ({ ...value, selected: selected.has(value.value) }));
      return {
        ...facet,
        selectedCount: selected.size,
        preview: values.slice(0, FACET_VALUE_PREVIEW),
        more: values.slice(FACET_VALUE_PREVIEW),
      };
    })
    .filter((facet) =>
      facet.selectedCount > 0 || facet.values.filter(({ count }) => count > 0).length >= 2,
    );
}

/** A price filter only helps when products differ in price (or one is applied). */
export function showsCatalogPriceFilter(
  priceRange: BuyerPriceRange | undefined,
  currentFilters: ProductListFilterState,
): boolean {
  return Boolean(currentFilters.minPrice || currentFilters.maxPrice) ||
    Boolean(priceRange && priceRange.max > priceRange.min);
}

export function showProductsLabel(total: number): string {
  return `Show ${total.toLocaleString("en-IN")} ${total === 1 ? "product" : "products"}`;
}

/** The filter form as listing URL params, without empty fields. */
export function catalogFilterSearchParams(form: HTMLFormElement): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    const text = String(value).trim().replace(/\s+/g, " ");
    if (text) params.append(key, text);
  }
  return params;
}

/** Listing URL params → the product-list API query that returns only the count. */
export function catalogCountQuery(params: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sortBy" || key === "page") continue;
    query.append(key === "q" ? "search" : key, value);
  }
  query.set("limit", "1");
  return query;
}

/**
 * Progressive enhancement for the server-rendered filter form. Without
 * JavaScript it is a plain GET form. With it, desktop applies each change
 * immediately and the phone sheet keeps a live "Show N products" count.
 */
export function setupCatalogFilters(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-catalog-filters]");
  if (!form || form.dataset.filtersBound === "true") return;
  form.dataset.filtersBound = "true";

  const desktop = window.matchMedia("(min-width: 1024px)");
  const apply = form.querySelector<HTMLButtonElement>("[data-catalog-filter-apply]");
  const endpoint = form.dataset.countEndpoint;
  let countTimer: ReturnType<typeof setTimeout> | undefined;
  let countRequest: AbortController | undefined;

  const refreshCount = () => {
    if (!apply || !endpoint) return;
    clearTimeout(countTimer);
    countRequest?.abort();
    apply.textContent = "Show products";
    countTimer = setTimeout(async () => {
      const request = new AbortController();
      countRequest = request;
      try {
        const response = await fetch(
          createApiUrl(`${endpoint}?${catalogCountQuery(catalogFilterSearchParams(form))}`),
          { signal: request.signal },
        );
        const body = (await response.json()) as { data?: { pagination?: { total?: unknown } } };
        const total = body.data?.pagination?.total;
        if (response.ok && typeof total === "number") apply.textContent = showProductsLabel(total);
      } catch {
        // Keep the neutral label; applying still works.
      }
    }, 250);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    navigateToCatalogFilterSearch(catalogFilterSearchParams(form));
  });
  form.addEventListener("change", (event) => {
    const target = event.target;
    // Search and price fields apply on Enter (or the Apply button), not per keystroke.
    if (target instanceof HTMLInputElement && (target.type === "search" || target.inputMode === "decimal")) {
      if (!desktop.matches) refreshCount();
      return;
    }
    if (desktop.matches) form.requestSubmit();
    else refreshCount();
  });

  // A checkbox tapped before this script loaded (slow networks) already holds
  // its new state; apply it now instead of leaving it silently unapplied.
  const tappedEarly = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
    .some((input) => input.checked !== input.defaultChecked);
  if (tappedEarly) {
    if (desktop.matches) form.requestSubmit();
    else refreshCount();
  }
}
