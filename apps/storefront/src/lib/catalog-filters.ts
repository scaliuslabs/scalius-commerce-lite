import type { BuyerPriceRange, ProductFacet } from "@/lib/api";
import { createApiUrl } from "@/lib/api/transport";
import { navigateToCatalogFilterSearch } from "./catalog-filter-dialog";
import {
  parseProductListRangeKey,
  productListRangeKey,
  type ProductListFilterState,
  type ProductListRangeBound,
} from "./product-list-query";

const FACET_VALUE_PREVIEW = 10;

function selectedValues(currentFilters: ProductListFilterState, key: string): string[] {
  const value = currentFilters[key];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** A range facet's applied bounds, as the URL holds them. */
export interface CatalogRangeSelection {
  min: string | null;
  max: string | null;
}

/**
 * Facets worth showing: at least two values, one of which still matches
 * products (a single-value facet filters nothing), a range whose products
 * differ, or any facet the buyer already uses so the selection can be
 * undone. Values the other selections rule out stay listed with a zero count
 * (rendered disabled) so the list does not jump. Values beyond the first ten
 * are folded. A value is selected by its URL value, not its label.
 */
export function visibleCatalogFacets(
  facets: readonly ProductFacet[],
  currentFilters: ProductListFilterState,
) {
  return facets
    .map((facet) => {
      if (facet.display === "range") {
        const bound = (name: ProductListRangeBound) =>
          selectedValues(currentFilters, productListRangeKey(facet.slug, name)).at(-1) ?? null;
        const applied: CatalogRangeSelection = { min: bound("min"), max: bound("max") };
        return {
          ...facet,
          values: [],
          applied,
          selectedCount: applied.min !== null || applied.max !== null ? 1 : 0,
          preview: [],
          more: [],
        };
      }
      const selected = new Set(selectedValues(currentFilters, facet.slug));
      const values = facet.values.map((value) => ({ ...value, selected: selected.has(value.value) }));
      return {
        ...facet,
        applied: null,
        selectedCount: selected.size,
        preview: values.slice(0, FACET_VALUE_PREVIEW),
        more: values.slice(FACET_VALUE_PREVIEW),
      };
    })
    .filter((facet) =>
      facet.selectedCount > 0 ||
      (facet.display === "range"
        ? Boolean(facet.range && facet.range.max > facet.range.min)
        : facet.values.length >= 2 && facet.values.some(({ count }) => count > 0)),
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

/** The phone sheet's apply button for a selection matching `total` products. */
export function catalogApplyButton(total: number): { label: string; disabled: boolean } {
  return total === 0
    ? { label: "No matching products", disabled: true }
    : { label: `Show ${total.toLocaleString("en-IN")} ${total === 1 ? "product" : "products"}`, disabled: false };
}

/**
 * Shows the counts for the pending selection: every facet value's count (the
 * API counts each facet against the other facets' selections), unticked
 * zero-count values disabled so no combination leads to an empty list, each
 * range's bounds as its placeholders, and the apply button. Values missing
 * from the facets match nothing; without facets only the button changes.
 */
export function applyCatalogFilterCounts(
  form: HTMLFormElement,
  facets: readonly ProductFacet[] | null,
  total: number,
): void {
  const counts = new Map(facets?.map((facet) => [
    facet.slug,
    new Map((Array.isArray(facet.values) ? facet.values : []).map(({ value, count }) => [value, count])),
  ]));
  const inputs = facets ? form.querySelectorAll<HTMLInputElement>("input[data-catalog-facet]") : [];
  for (const input of inputs) {
    const count = counts.get(input.name)?.get(input.value) ?? 0;
    input.disabled = count === 0 && !input.checked;
    const countLabel = input.closest("label")?.querySelector("[data-catalog-facet-count]");
    if (countLabel) countLabel.textContent = String(count);
  }
  const ranges = new Map(facets?.map((facet) => [facet.slug, facet.range]));
  const rangeInputs = facets ? form.querySelectorAll<HTMLInputElement>("input[data-catalog-range]") : [];
  for (const input of rangeInputs) {
    const key = parseProductListRangeKey(input.name);
    const bound = key ? ranges.get(key.slug)?.[key.bound] : undefined;
    if (typeof bound === "number" && Number.isFinite(bound)) input.placeholder = String(bound);
  }
  const apply = form.querySelector<HTMLButtonElement>("[data-catalog-filter-apply]");
  if (apply) {
    const { label, disabled } = catalogApplyButton(total);
    apply.textContent = label;
    apply.disabled = disabled;
  }
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
    if (key === "sortBy" || key === "page" || key === "limit") continue;
    query.append(key === "q" ? "search" : key, value);
  }
  query.set("limit", "1");
  return query;
}

/** What the buyer reads for a value (its label, not the submitted value or its count). */
const facetValueText = (label: HTMLLabelElement) =>
  label.querySelector("span:not([data-catalog-facet-count]):not([aria-hidden])")?.textContent ??
  label.textContent ??
  "";

/**
 * A search field over a long facet list (Apple Gadgets): typing hides the
 * values that do not contain the text and opens the folded rest. Enter
 * never submits the form from it.
 */
export function setupCatalogFacetSearch(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-catalog-facet-search]").forEach((box) => {
    const input = box.querySelector<HTMLInputElement>("input[data-catalog-facet-query]");
    const list = box.closest("fieldset");
    if (!input || !list || box.dataset.bound === "true") return;
    box.dataset.bound = "true";
    box.hidden = false;
    const empty = box.querySelector<HTMLElement>("[data-catalog-facet-search-empty]");
    const more = list.querySelector<HTMLDetailsElement>("details");
    const moreWasOpen = more?.open ?? false;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    input.addEventListener("input", () => {
      const needle = input.value.trim().toLocaleLowerCase();
      let shown = 0;
      list.querySelectorAll<HTMLLabelElement>("label").forEach((label) => {
        const match = !needle || facetValueText(label).toLocaleLowerCase().includes(needle);
        label.hidden = !match;
        if (match) shown += 1;
      });
      if (more) {
        more.open = needle ? true : moreWasOpen;
        more.querySelector("summary")!.hidden = Boolean(needle);
      }
      if (empty) empty.hidden = shown > 0;
    });
  });
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

  // The desktop sidebar applies each change at once; a sheet or a drawer
  // (every width) waits for its "Show N products" button.
  const wide = window.matchMedia("(min-width: 1024px)");
  const drawer = form.dataset.catalogApply === "sheet";
  const desktop = { get matches() { return wide.matches && !drawer; } };
  const apply = form.querySelector<HTMLButtonElement>("[data-catalog-filter-apply]");
  setupCatalogFacetSearch(form);
  const endpoint = form.dataset.countEndpoint;
  let countTimer: ReturnType<typeof setTimeout> | undefined;
  let countRequest: AbortController | undefined;

  const refreshCount = () => {
    if (!apply || !endpoint) return;
    clearTimeout(countTimer);
    countRequest?.abort();
    apply.textContent = "Show products";
    apply.disabled = false;
    countTimer = setTimeout(async () => {
      const request = new AbortController();
      countRequest = request;
      try {
        const response = await fetch(
          createApiUrl(`${endpoint}?${catalogCountQuery(catalogFilterSearchParams(form))}`),
          { signal: request.signal },
        );
        const body = (await response.json()) as {
          data?: { pagination?: { total?: unknown }; facets?: unknown };
        };
        const total = body.data?.pagination?.total;
        const facets = body.data?.facets;
        if (response.ok && typeof total === "number") {
          applyCatalogFilterCounts(form, Array.isArray(facets) ? facets as ProductFacet[] : null, total);
        }
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
    // A facet's own search narrows its list; it is not a filter.
    if (target instanceof HTMLElement && target.hasAttribute("data-catalog-facet-query")) return;
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
