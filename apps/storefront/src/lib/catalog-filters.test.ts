// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/transport", () => ({ createApiUrl: (path: string) => `https://api.test/api/v1${path}` }));

import {
  catalogCountQuery,
  catalogFilterSearchParams,
  setupCatalogFilters,
  showsCatalogPriceFilter,
  visibleCatalogFacets,
} from "./catalog-filters";

const facet = (slug: string, values: Array<[string, number]>) => ({
  id: slug,
  name: slug,
  slug,
  values: values.map(([value, count]) => ({ value, count })),
});

function renderForm(desktop: boolean, beforeScript?: (form: HTMLFormElement) => void) {
  document.body.innerHTML = `
    <form data-catalog-filters data-count-endpoint="/categories/footwear/products">
      <input type="hidden" name="sortBy" value="price-asc" />
      <input type="search" name="q" value="  running   shoe " />
      <input type="checkbox" role="switch" name="hasDiscount" value="true" />
      <input type="checkbox" name="option.size" value="42" />
      <input type="text" inputmode="decimal" name="minPrice" value="" />
      <button type="submit" data-catalog-filter-apply>Show 10 products</button>
    </form>
  `;
  vi.stubGlobal("matchMedia", () => ({ matches: desktop, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  beforeScript?.(document.querySelector("form")!);
  setupCatalogFilters();
  return document.querySelector("form")!;
}

describe("catalog filter facets", () => {
  it("hides facets that cannot narrow the list but keeps ones the buyer uses", () => {
    const facets = [
      facet("brand", [["Northline", 10]]),
      facet("option.size", [["41", 4], ["42", 6]]),
      facet("color", [["Red", 3], ["Blue", 0]]),
      facet("material", [["Cotton", 0], ["Silk", 1]]),
    ];

    expect(visibleCatalogFacets(facets, {}).map(({ slug }) => slug)).toEqual(["option.size"]);
    expect(visibleCatalogFacets(facets, { brand: "Northline" }).map(({ slug }) => slug))
      .toEqual(["brand", "option.size"]);
  });

  it("folds long value lists after ten and marks selected values", () => {
    const many = facet("size", Array.from({ length: 13 }, (_, index): [string, number] => [`${36 + index}`, 1]));
    const [shown] = visibleCatalogFacets([many], { size: ["48"] });

    expect(shown!.preview).toHaveLength(10);
    expect(shown!.more.map(({ value, selected }) => [value, selected])).toEqual([
      ["46", false], ["47", false], ["48", true],
    ]);
  });

  it("offers a price filter only when prices differ or one is applied", () => {
    expect(showsCatalogPriceFilter({ min: 0, max: 0 }, {})).toBe(false);
    expect(showsCatalogPriceFilter({ min: 500, max: 500 }, {})).toBe(false);
    expect(showsCatalogPriceFilter({ min: 500, max: 900 }, {})).toBe(true);
    expect(showsCatalogPriceFilter({ min: 0, max: 0 }, { maxPrice: "100" })).toBe(true);
  });
});

describe("catalog filter form", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/categories/footwear?sortBy=price-asc");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("serializes checked native controls and skips empty fields", () => {
    const form = renderForm(true);
    form.querySelector<HTMLInputElement>("[name=hasDiscount]")!.checked = true;

    const params = catalogFilterSearchParams(form);
    expect(params.toString()).toBe("sortBy=price-asc&q=running+shoe&hasDiscount=true");
    expect(catalogCountQuery(params).toString()).toBe("search=running+shoe&hasDiscount=true&limit=1");
  });

  it("applies a desktop switch as soon as it changes", () => {
    const form = renderForm(true);
    const toggle = form.querySelector<HTMLInputElement>("[name=hasDiscount]")!;

    toggle.click();

    expect(window.location.pathname).toBe("/categories/footwear");
    expect(window.location.search).toBe("?sortBy=price-asc&q=running+shoe&hasDiscount=true");
  });

  it("applies a switch the buyer tapped before the script loaded", () => {
    renderForm(true, (form) => {
      form.querySelector<HTMLInputElement>("[name=hasDiscount]")!.checked = true;
    });

    expect(window.location.search).toBe("?sortBy=price-asc&q=running+shoe&hasDiscount=true");
  });

  it("keeps the phone sheet open and updates the live product count", async () => {
    vi.useFakeTimers();
    const form = renderForm(false);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { pagination: { total: 5 } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const apply = form.querySelector("[data-catalog-filter-apply]")!;

    form.querySelector<HTMLInputElement>("[name='option.size']")!.click();
    expect(apply.textContent).toBe("Show products");
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();

    expect(window.location.search).toBe("?sortBy=price-asc");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.test/api/v1/categories/footwear/products?search=running+shoe&option.size=42&limit=1",
    );
    expect(apply.textContent).toBe("Show 5 products");
  });
});
