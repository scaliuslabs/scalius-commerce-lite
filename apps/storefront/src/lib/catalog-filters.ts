import type { BuyerPriceRange, ProductFacet, RatingFacetValue } from "@/lib/api";
import { createApiUrl } from "@/lib/api/transport";
import { navigateToCatalogFilterSearch } from "./catalog-filter-dialog";
import { catalogSwatchPaint } from "./catalog-swatch";
import {
  PRODUCT_LIST_MIN_RATING_PARAM,
  parseProductListRangeKey,
  productListRangeKey,
  type ProductListFilterState,
  type ProductListRangeBound,
} from "./product-list-query";

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
 * (rendered disabled) so the list does not jump. A value is selected by its
 * URL value, not its label.
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
          values: [] as CatalogFacetValue[],
          applied,
          selectedCount: applied.min !== null || applied.max !== null ? 1 : 0,
        };
      }
      const selected = new Set(selectedValues(currentFilters, facet.slug));
      const values: CatalogFacetValue[] = facet.values.map((value) => ({ ...value, selected: selected.has(value.value) }));
      return { ...facet, values, applied: null, selectedCount: selected.size };
    })
    .filter((facet) =>
      facet.selectedCount > 0 ||
      (facet.display === "range"
        ? Boolean(facet.range && facet.range.max > facet.range.min)
        : facet.values.length >= 2 && facet.values.some(({ count }) => count > 0)),
    );
}

export type CatalogFacetValue = ProductFacet["values"][number] & { selected: boolean };
export type VisibleCatalogFacet = ReturnType<typeof visibleCatalogFacets>[number];

/**
 * For the small-catalogue rule: per facet worth showing, the values that
 * still match products (a range, and the price, count 2 when they span).
 */
export function catalogFacetValueCounts(
  facets: readonly VisibleCatalogFacet[],
  priceRange: BuyerPriceRange | undefined,
): number[] {
  const counts = facets.map((facet) => facet.display === "range"
    ? (facet.range && facet.range.max > facet.range.min ? 2 : 1)
    : facet.values.filter(({ count }) => count > 0).length);
  if (priceRange) counts.push(priceRange.max > priceRange.min ? 2 : 1);
  return counts;
}

/** One value row of a facet group: its own facet's input name and URL value. */
export interface CatalogFacetRow extends CatalogFacetValue {
  /** The input name: the facet slug this value filters (merged groups hold two). */
  slug: string;
}

/**
 * One group of the filter form. Facets that share a name ("RAM" as an
 * option axis and as an attribute) are one group: its rows keep their own
 * facet's input name, and a label both carry shows once (the first facet's
 * row, the option axis, unless the buyer ticked the other one).
 */
export interface CatalogFacetGroup {
  /** The first facet's slug: the group's id, anchor and `showAll` value. */
  key: string;
  name: string;
  kind: "values" | "range" | "category";
  facets: VisibleCatalogFacet[];
  /** Values in the HTML: every selected one, then the most common, in the facet's own order. */
  rows: CatalogFacetRow[];
  /** Values left out of the HTML ("See more" fetches them, or `?showAll=` renders them). */
  more: number;
  /** `showAll` names this group: every value is in the HTML. */
  expanded: boolean;
  selectedCount: number;
}

const labelKey = (label: string) => label.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * The filter form's groups: category links, then the facets in the API's
 * order (brand, option axes, then attributes in the category's spec order),
 * same-name value facets merged. At most `valuesInHtml` values per group are
 * sent in the HTML (the Slice 3 budget: 10), every selected value always.
 */
export function catalogFacetGroups(
  facets: readonly VisibleCatalogFacet[],
  { valuesInHtml, showAll }: { valuesInHtml: number; showAll?: string | null },
): CatalogFacetGroup[] {
  const groups: CatalogFacetGroup[] = [];
  const byName = new Map<string, CatalogFacetGroup>();
  for (const facet of facets) {
    const kind = facet.kind === "category" ? "category" : facet.display === "range" ? "range" : "values";
    const nameKey = labelKey(facet.name);
    const existing = kind === "values" ? byName.get(nameKey) : undefined;
    if (existing) {
      existing.facets.push(facet);
      existing.selectedCount += facet.selectedCount;
      continue;
    }
    const group: CatalogFacetGroup = {
      key: facet.slug,
      name: facet.name,
      kind,
      facets: [facet],
      rows: [],
      more: 0,
      expanded: false,
      selectedCount: facet.selectedCount,
    };
    if (kind === "values") byName.set(nameKey, group);
    groups.push(group);
  }
  for (const group of groups) {
    if (group.kind === "range") continue;
    group.expanded = Boolean(showAll) && group.facets.some((facet) => facet.slug === showAll);
    const rows: CatalogFacetRow[] = [];
    const shownLabels = new Map<string, number>();
    for (const facet of group.facets) {
      for (const value of facet.values) {
        const row = { ...value, slug: facet.slug };
        const at = shownLabels.get(labelKey(value.label));
        if (at === undefined) {
          shownLabels.set(labelKey(value.label), rows.length);
          rows.push(row);
        } else if (row.selected && !rows[at]!.selected) {
          rows[at] = row;
        }
      }
    }
    const limit = group.expanded ? rows.length : Math.max(valuesInHtml, rows.filter((row) => row.selected).length);
    const kept = new Set(
      rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => Number(right.row.selected) - Number(left.row.selected) || right.row.count - left.row.count || left.index - right.index)
        .slice(0, limit)
        .map(({ index }) => index),
    );
    group.rows = rows.filter((_, index) => kept.has(index));
    group.more = rows.length - group.rows.length;
  }
  return groups;
}

/** One "N★ & up" row of the Customer rating group. */
export interface CatalogRatingRow {
  min: number;
  count: number;
  selected: boolean;
}

/**
 * The Customer rating group (Amazon's "Customer Reviews", Daraz's "Rating"):
 * "4★ & up", "3★ & up", "2★ & up" with their counts in the listing's scope,
 * highest first, plus the buyer's own choice. Nothing while the store has no
 * published review (`hasReviews`) or nothing in scope has one (the API sends
 * no rows), unless the buyer chose a rating and needs to undo it.
 */
export function catalogRatingRows(
  ratingFacet: readonly RatingFacetValue[] | undefined,
  currentFilters: ProductListFilterState,
  hasReviews: boolean,
): CatalogRatingRow[] {
  const chosen = Number(selectedValues(currentFilters, PRODUCT_LIST_MIN_RATING_PARAM).at(-1) ?? 0) || null;
  if (!hasReviews && chosen === null) return [];
  const rows = new Map((ratingFacet ?? []).map(({ min, count }) => [min, count]));
  if (chosen !== null && !rows.has(chosen)) rows.set(chosen, 0);
  if (chosen === null && ![...rows.values()].some((count) => count > 0)) return [];
  return [...rows]
    .sort(([left], [right]) => right - left)
    .map(([min, count]) => ({ min, count, selected: min === chosen }));
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
  ratingFacet: readonly RatingFacetValue[] | null = null,
): void {
  // "N★ & up" rows count against every other selection, like a facet value.
  if (ratingFacet) {
    const ratingCounts = new Map(ratingFacet.map(({ min, count }) => [String(min), count]));
    for (const input of form.querySelectorAll<HTMLInputElement>("input[data-catalog-rating]")) {
      if (!input.value) continue;
      const count = ratingCounts.get(input.value) ?? 0;
      input.disabled = count === 0 && !input.checked;
      const countLabel = input.closest("label")?.querySelector("[data-catalog-facet-count]");
      if (countLabel) countLabel.textContent = String(count);
    }
  }
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

/** What the buyer reads for a value row (its label, not its count). */
const facetValueText = (row: Element) =>
  row.querySelector("[data-catalog-facet-label]")?.textContent ??
  row.textContent ??
  "";

/**
 * The listing's facets with every value (up to the API's cap: 100, 500
 * brands), for "See more": the same product-list request as the live count,
 * for the page's own URL, read once per page. The public API caches it
 * under the store's cache generation.
 */
let listingFacetsRequest: { key: string; facets: Promise<ProductFacet[] | null> } | null = null;
function readListingFacets(endpoint: string): Promise<ProductFacet[] | null> {
  const params = new URLSearchParams(window.location.search);
  params.delete("showAll");
  const key = `${endpoint}?${catalogCountQuery(params)}`;
  if (listingFacetsRequest?.key !== key) {
    listingFacetsRequest = {
      key,
      facets: fetch(createApiUrl(key))
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { data?: { facets?: unknown } } | null) => {
          const facets = body?.data?.facets;
          return Array.isArray(facets) ? (facets as ProductFacet[]) : null;
        })
        .catch(() => null),
    };
  }
  return listingFacetsRequest.facets;
}

/** The query a category link carries: the buyer's filters and search, not their page, sort, size or `showAll`. */
function carriedListingQuery(): string {
  const params = new URLSearchParams(window.location.search);
  for (const key of ["page", "sortBy", "limit", "showAll"]) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Adds a group's values that are not in the HTML, cloned from its first row
 * (so they look, submit and count like the server's), after the last row.
 * Returns the rows it added.
 */
function appendFacetRows(group: HTMLElement, facets: readonly ProductFacet[]): HTMLElement[] {
  const slugs = (group.dataset.facetSlugs ?? "").split(" ").filter(Boolean);
  const category = group.dataset.facetKind === "category";
  const rows = [...group.querySelectorAll<HTMLElement>("[data-catalog-facet-row]")];
  const template = rows.find((row) => (category ? row instanceof HTMLAnchorElement : row.querySelector("input")));
  const anchor = rows.at(-1);
  if (!template || !anchor) return [];
  const seenValues = new Set(rows.map((row) => {
    const input = row.querySelector<HTMLInputElement>("input[data-catalog-facet]");
    return input ? `${input.name}\u0000${input.value}` : facetValueText(row).trim().toLocaleLowerCase();
  }));
  const seenLabels = new Set(rows.map((row) => facetValueText(row).trim().toLocaleLowerCase()));
  const added: HTMLElement[] = [];
  let after: Element = category ? anchor.closest("li") ?? anchor : anchor;
  for (const slug of slugs) {
    const facet = facets.find((candidate) => candidate.slug === slug);
    for (const value of facet?.values ?? []) {
      const labelKey = value.label.trim().toLocaleLowerCase();
      if (seenLabels.has(labelKey) || seenValues.has(`${slug}\u0000${value.value}`)) continue;
      if (category && value.count === 0) continue;
      seenLabels.add(labelKey);
      const row = template.cloneNode(true) as HTMLElement;
      row.dataset.catalogFacetAdded = "";
      const text = row.querySelector("[data-catalog-facet-label]");
      const count = row.querySelector("[data-catalog-facet-count]");
      if (text) text.textContent = value.label;
      if (count) count.textContent = String(value.count);
      if (category) {
        (row as HTMLAnchorElement).href = `/categories/${encodeURIComponent(value.value)}${carriedListingQuery()}`;
        const item = document.createElement("li");
        item.append(row);
        after.after(item);
        after = item;
      } else {
        const input = row.querySelector<HTMLInputElement>("input[data-catalog-facet]")!;
        input.name = slug;
        input.value = value.value;
        input.checked = false;
        input.defaultChecked = false;
        input.disabled = value.count === 0;
        const swatch = row.querySelector<HTMLElement>("[data-catalog-swatch]");
        if (swatch) {
          const paint = catalogSwatchPaint(value);
          swatch.style.background = paint ?? "";
          swatch.classList.toggle("bg-muted", !paint);
        }
        after.after(row);
        after = row;
      }
      added.push(row);
    }
  }
  return added;
}

/**
 * "See more" in place (Amazon, Daraz): the first click fetches the group's
 * other values and adds them; later clicks fold and unfold them. Without
 * JavaScript the link renders the page with every value (`?showAll=`).
 * Resolves once the group holds every value (the facet search waits on it).
 */
function setupFacetMore(form: HTMLFormElement): Map<HTMLElement, () => Promise<void>> {
  const expanders = new Map<HTMLElement, () => Promise<void>>();
  const endpoint = form.dataset.countEndpoint;
  form.querySelectorAll<HTMLAnchorElement>("a[data-catalog-facet-more]").forEach((link) => {
    const group = link.closest<HTMLElement>("[data-catalog-facet-group]");
    // An expanded group (`?showAll=`) already holds every value: its link folds back by navigating.
    if (!group || !endpoint || link.getAttribute("aria-expanded") === "true") return;
    let added: HTMLElement[] | null = null;
    let loading: Promise<void> | null = null;
    const load = () => {
      loading ??= readListingFacets(endpoint).then((facets) => {
        if (!facets) {
          loading = null;
          return;
        }
        added = appendFacetRows(group, facets);
      });
      return loading;
    };
    const show = (open: boolean) => {
      for (const row of added ?? []) (row.closest("li") ?? row).hidden = !open;
      link.setAttribute("aria-expanded", String(open));
      link.textContent = open ? link.dataset.lessLabel ?? "See less" : link.dataset.moreLabel ?? "See more";
    };
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      if (added) {
        show(link.getAttribute("aria-expanded") !== "true");
        return;
      }
      link.setAttribute("aria-busy", "true");
      await load();
      link.removeAttribute("aria-busy");
      // The request failed: follow the link (the page with every value).
      if (!added) {
        window.location.href = link.href;
        return;
      }
      show(true);
    });
    expanders.set(group, async () => {
      await load();
      if (added) show(true);
    });
  });
  return expanders;
}

/**
 * A search field over a long facet list (Apple Gadgets, brand lists): the
 * first keystroke loads the group's other values, then typing hides the
 * values that do not contain the text. Enter never submits the form from it.
 */
export function setupCatalogFacetSearch(root: ParentNode, expanders?: Map<HTMLElement, () => Promise<void>>): void {
  root.querySelectorAll<HTMLElement>("[data-catalog-facet-search]").forEach((box) => {
    const input = box.querySelector<HTMLInputElement>("input[data-catalog-facet-query]");
    const list = box.closest<HTMLElement>("fieldset");
    if (!input || !list || box.dataset.bound === "true") return;
    box.dataset.bound = "true";
    box.hidden = false;
    const empty = box.querySelector<HTMLElement>("[data-catalog-facet-search-empty]");
    const more = list.querySelector<HTMLElement>("[data-catalog-facet-more]");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    input.addEventListener("input", async () => {
      const needle = input.value.trim().toLocaleLowerCase();
      if (needle) await expanders?.get(list)?.();
      let shown = 0;
      list.querySelectorAll<HTMLElement>("[data-catalog-facet-row]").forEach((row) => {
        const match = !needle || facetValueText(row).toLocaleLowerCase().includes(needle);
        row.hidden = !match;
        if (match) shown += 1;
      });
      if (more) more.hidden = Boolean(needle);
      if (empty) empty.hidden = shown > 0;
    });
  });
}

/**
 * Star Tech's price slider: two thumbs written into the Min and Max fields
 * (the fields submit; the slider has no name). Shown only with JavaScript.
 */
function setupPriceSlider(form: HTMLFormElement): void {
  const slider = form.querySelector<HTMLElement>("[data-catalog-price-slider]");
  const low = slider?.querySelector<HTMLInputElement>('[data-catalog-price-thumb="min"]');
  const high = slider?.querySelector<HTMLInputElement>('[data-catalog-price-thumb="max"]');
  const minField = form.querySelector<HTMLInputElement>('input[name="minPrice"]');
  const maxField = form.querySelector<HTMLInputElement>('input[name="maxPrice"]');
  if (!slider || !low || !high || !minField || !maxField) return;
  slider.hidden = false;
  const floor = Number(low.min);
  const ceiling = Number(high.max);
  const sync = (moved: HTMLInputElement) => {
    if (Number(low.value) > Number(high.value)) {
      if (moved === low) low.value = high.value;
      else high.value = low.value;
    }
    minField.value = Number(low.value) > floor ? low.value : "";
    maxField.value = Number(high.value) < ceiling ? high.value : "";
  };
  low.addEventListener("input", () => sync(low));
  high.addEventListener("input", () => sync(high));
}

/**
 * The bar's dropdowns (Dawn): one open at a time, closed by a click outside
 * or Escape; "More filters" shows the groups past the bar's count.
 */
function setupFilterBar(form: HTMLFormElement): void {
  if (form.dataset.placement !== "bar") return;
  const dropdowns = [...form.querySelectorAll<HTMLDetailsElement>("details[data-catalog-dropdown]")];
  const wide = window.matchMedia("(min-width: 1024px)");
  dropdowns.forEach((dropdown) => {
    dropdown.addEventListener("toggle", () => {
      if (!dropdown.open || !wide.matches) return;
      for (const other of dropdowns) if (other !== dropdown) other.open = false;
    });
  });
  document.addEventListener("click", (event) => {
    if (!wide.matches || !(event.target instanceof Node)) return;
    for (const dropdown of dropdowns) if (dropdown.open && !dropdown.contains(event.target)) dropdown.open = false;
  });
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !wide.matches) return;
    const open = dropdowns.find((dropdown) => dropdown.open);
    if (!open) return;
    open.open = false;
    open.querySelector("summary")?.focus();
  });
  const more = form.querySelector<HTMLButtonElement>("[data-catalog-bar-more]");
  more?.addEventListener("click", () => {
    const open = !form.hasAttribute("data-bar-open");
    form.toggleAttribute("data-bar-open", open);
    more.setAttribute("aria-expanded", String(open));
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
  setupCatalogFacetSearch(form, setupFacetMore(form));
  setupPriceSlider(form);
  setupFilterBar(form);
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
          data?: { pagination?: { total?: unknown }; facets?: unknown; ratingFacet?: unknown };
        };
        const total = body.data?.pagination?.total;
        const facets = body.data?.facets;
        const ratingFacet = body.data?.ratingFacet;
        if (response.ok && typeof total === "number") {
          applyCatalogFilterCounts(
            form,
            Array.isArray(facets) ? facets as ProductFacet[] : null,
            total,
            Array.isArray(ratingFacet) ? ratingFacet as RatingFacetValue[] : null,
          );
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
  const tappedEarly = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox], input[type=radio]")]
    .some((input) => input.checked !== input.defaultChecked);
  if (tappedEarly) {
    if (desktop.matches) form.requestSubmit();
    else refreshCount();
  }
}
