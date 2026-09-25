// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/transport", () => ({ createApiUrl: (path: string) => `https://api.test/api/v1${path}` }));

import type { ProductFacet } from "@/lib/api";
import {
  applyCatalogFilterCounts,
  catalogCountQuery,
  catalogFacetGroups,
  catalogFilterSearchParams,
  catalogRatingRows,
  setupCatalogFilters,
  showsCatalogPriceFilter,
  visibleCatalogFacets,
} from "./catalog-filters";

const facet = (slug: string, values: Array<[string, number]>): ProductFacet => ({
  id: slug,
  name: slug,
  slug,
  kind: slug.startsWith("option.") ? "option" : "attribute",
  display: "checkbox",
  unit: null,
  values: values.map(([value, count]) => ({ value, label: value, count, swatch: null })),
  range: null,
});

const rangeFacet = (slug: string, range: { min: number; max: number } | null): ProductFacet => ({
  id: slug,
  name: "Display size",
  slug,
  kind: "attribute",
  display: "range",
  unit: "in",
  values: [],
  range,
});

function renderForm(desktop: boolean, beforeScript?: (form: HTMLFormElement) => void) {
  document.body.innerHTML = `
    <form data-catalog-filters data-count-endpoint="/categories/footwear/products">
      <input type="hidden" name="sortBy" value="price-asc" />
      <input type="search" name="q" value="  running   shoe " />
      <input type="checkbox" role="switch" name="hasDiscount" value="true" />
      <input type="checkbox" name="option.size" value="42" />
      <input type="text" inputmode="decimal" name="minPrice" value="" />
      <input type="text" inputmode="decimal" name="display-size.min" value="" data-catalog-range="min" />
      <input type="text" inputmode="decimal" name="display-size.max" value="" data-catalog-range="max" />
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
      facet("finish", [["Matte", 0], ["Gloss", 0]]),
    ];

    expect(visibleCatalogFacets(facets, {}).map(({ slug }) => slug)).toEqual(["option.size"]);
    expect(visibleCatalogFacets(facets, { brand: "Northline" }).map(({ slug }) => slug))
      .toEqual(["brand", "option.size"]);
  });

  it("keeps a facet steady when another selection rules some of its values out", () => {
    const [color] = visibleCatalogFacets([facet("option.color", [["Black", 2], ["Chalk", 0]])], { "option.size": "42" });

    expect(color!.values.map(({ value, count }) => [value, count])).toEqual([["Black", 2], ["Chalk", 0]]);
  });

  it("sends ten values per group in the HTML, the selected and most common first, in the facet's order", () => {
    const many = facet("size", Array.from({ length: 13 }, (_, index): [string, number] => [`${36 + index}`, index === 12 ? 1 : 20 - index]));
    const [group] = catalogFacetGroups(visibleCatalogFacets([many], { size: ["48"] }), { valuesInHtml: 10 });

    expect(group!.rows.map(({ value, selected }) => [value, selected])).toEqual([
      ["36", false], ["37", false], ["38", false], ["39", false], ["40", false],
      ["41", false], ["42", false], ["43", false], ["44", false], ["48", true],
    ]);
    expect(group!.more).toBe(3);
    const [expanded] = catalogFacetGroups(visibleCatalogFacets([many], {}), { valuesInHtml: 10, showAll: "size" });
    expect([expanded!.rows.length, expanded!.more, expanded!.expanded]).toEqual([13, 0, true]);
  });

  it("merges an option axis and an attribute that share a name into one group, each row keeping its facet", () => {
    const option = { ...facet("option.ram", [["8GB", 5], ["16GB", 3]]), name: "RAM", kind: "option" as const };
    const attribute = { ...facet("ram", [["8GB", 9], ["4GB", 2]]), name: "RAM" };
    const groups = catalogFacetGroups(visibleCatalogFacets([option, attribute], {}), { valuesInHtml: 10 });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map(({ slug, value }) => `${slug}=${value}`)).toEqual(["option.ram=8GB", "option.ram=16GB", "ram=4GB"]);
    // A ticked attribute value replaces the axis row of the same label.
    const ticked = catalogFacetGroups(visibleCatalogFacets([option, attribute], { ram: "8GB" }), { valuesInHtml: 10 });
    expect(ticked[0]!.rows.map(({ slug, value, selected }) => `${slug}=${value}${selected ? "*" : ""}`)).toEqual(["ram=8GB*", "option.ram=16GB", "ram=4GB"]);
  });

  it("shows a range when its products differ, or while a bound is applied", () => {
    const facets = [rangeFacet("display-size", { min: 13, max: 15.6 }), rangeFacet("weight", { min: 1.2, max: 1.2 }), rangeFacet("battery", null)];
    const [shown, ...rest] = visibleCatalogFacets(facets, {});
    expect([shown!.slug, rest]).toEqual(["display-size", []]);
    expect(shown).toMatchObject({ applied: { min: null, max: null }, selectedCount: 0, values: [] });

    const applied = visibleCatalogFacets(facets, { "weight.max": "1.5", "display-size.min": "14" });
    expect(applied.map(({ slug, applied: bounds, selectedCount }) => [slug, bounds, selectedCount])).toEqual([
      ["display-size", { min: "14", max: null }, 1],
      ["weight", { min: null, max: "1.5" }, 1],
    ]);
  });

  it("selects values by their URL value, not their label", () => {
    const brand: ProductFacet = {
      ...facet("brand", []),
      kind: "brand",
      values: [
        { value: "samsung", label: "Samsung", count: 3, swatch: null },
        { value: "apple", label: "Apple", count: 2, swatch: null },
      ],
    };
    const [shown] = visibleCatalogFacets([brand], { brand: ["samsung", "Apple"] });
    expect(shown!.values.map(({ label, selected }) => [label, selected])).toEqual([["Samsung", true], ["Apple", false]]);
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

  it("submits only the range bounds the buyer typed", () => {
    const form = renderForm(true);
    form.querySelector<HTMLInputElement>("[name='display-size.max']")!.value = " 15.6 ";

    const params = catalogFilterSearchParams(form);
    expect(params.toString()).toBe("sortBy=price-asc&q=running+shoe&display-size.max=15.6");
    expect(catalogCountQuery(params).toString()).toBe("search=running+shoe&display-size.max=15.6&limit=1");
  });

  it("applies a desktop range on Enter, not on every change", () => {
    const form = renderForm(true);
    const max = form.querySelector<HTMLInputElement>("[name='display-size.max']")!;
    max.value = "15.6";
    max.dispatchEvent(new Event("change", { bubbles: true }));
    expect(window.location.search).toBe("?sortBy=price-asc");

    form.requestSubmit();
    expect(window.location.search).toBe("?sortBy=price-asc&q=running+shoe&display-size.max=15.6");
  });

  it("applies a desktop switch as soon as it changes", () => {
    const form = renderForm(true);
    const toggle = form.querySelector<HTMLInputElement>("[name=hasDiscount]")!;

    toggle.click();

    expect(window.location.pathname).toBe("/categories/footwear");
    expect(window.location.search).toBe("?sortBy=price-asc&q=running+shoe&hasDiscount=true");
  });

  it("waits for the apply button in a filter drawer, even on a computer", () => {
    const form = renderForm(true, (element) => element.setAttribute("data-catalog-apply", "sheet"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    form.querySelector<HTMLInputElement>("[name=hasDiscount]")!.click();

    expect(window.location.search).toBe("?sortBy=price-asc");
    expect(form.querySelector("[data-catalog-filter-apply]")!.textContent).toBe("Show products");
  });

  it("keeps the page size and drops it from the count query", () => {
    const form = renderForm(true);
    form.insertAdjacentHTML("afterbegin", '<input type="hidden" name="limit" value="40" />');
    const params = catalogFilterSearchParams(form);
    expect(params.get("limit")).toBe("40");
    expect(catalogCountQuery(params).getAll("limit")).toEqual(["1"]);
  });

  it("fetches a group's other values for See more and its search, without submitting", async () => {
    const row = (value: string, label: string, count: number) =>
      `<label class="catalog-facet-row" data-catalog-facet-row><input type="checkbox" name="brand" value="${value}" data-catalog-facet /><span data-catalog-facet-label>${label}</span><span data-catalog-facet-count>${count}</span></label>`;
    document.body.innerHTML = `
      <form data-catalog-filters data-count-endpoint="/categories/laptops/products">
        <fieldset data-catalog-facet-group data-facet-kind="values" data-facet-slugs="brand">
          <div data-catalog-facet-search hidden>
            <input type="search" data-catalog-facet-query />
            <p data-catalog-facet-search-empty hidden>No matches</p>
          </div>
          <div>${row("asus", "Asus", 3)}${row("acer", "Acer", 1)}${row("hp", "Hewlett-Packard", 2)}</div>
          <a href="/categories/laptops?showAll=brand" data-catalog-facet-more data-more-label="See more (1)" data-less-label="See less" aria-expanded="false">See more (1)</a>
        </fieldset>
      </form>
    `;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        pagination: { total: 6 },
        facets: [{ id: "brand", slug: "brand", name: "Brand", kind: "brand", display: "checkbox", unit: null, range: null, values: [
          { value: "asus", label: "Asus", count: 3, swatch: null },
          { value: "lenovo", label: "Lenovo", count: 4, swatch: null },
          { value: "acer", label: "Acer", count: 1, swatch: null },
          { value: "hp", label: "Hewlett-Packard", count: 2, swatch: null },
        ] }],
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    setupCatalogFilters();
    const box = document.querySelector<HTMLElement>("[data-catalog-facet-search]")!;
    const input = box.querySelector("input")!;
    const more = document.querySelector<HTMLAnchorElement>("a[data-catalog-facet-more]")!;
    expect(box.hidden).toBe(false);

    const visible = () => [...document.querySelectorAll<HTMLElement>("fieldset [data-catalog-facet-row]")]
      .filter((element) => !element.hidden)
      .map((element) => element.querySelector("[data-catalog-facet-label]")!.textContent);
    // Typing loads the values the HTML left out (once), then narrows by label.
    input.value = "LEN";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(visible()).toEqual(["Lenovo"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The page's own listing (sort and page size dropped), one product: only its facets matter.
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.test/api/v1/categories/laptops/products?limit=1");
    const added = document.querySelector<HTMLInputElement>("input[value='lenovo']")!;
    expect([added.name, added.checked, added.disabled]).toEqual(["brand", false, false]);
    expect(more.hidden).toBe(true);

    // It searches what the buyer reads: the label, never the URL value or the count.
    input.value = "packard";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(visible()).toEqual(["Hewlett-Packard"]));
    input.value = "zz";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(box.querySelector<HTMLElement>("[data-catalog-facet-search-empty]")!.hidden).toBe(false));
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(visible()).toHaveLength(4));
    expect(more.hidden).toBe(false);

    // The search left every value shown ("See less"); the link folds and
    // unfolds the fetched values without another request.
    expect(more.textContent).toBe("See less");
    more.click();
    await vi.waitFor(() => expect(visible()).toEqual(["Asus", "Acer", "Hewlett-Packard"]));
    expect([more.textContent, more.getAttribute("aria-expanded")]).toEqual(["See more (1)", "false"]);
    more.click();
    await vi.waitFor(() => expect(visible()).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    // Typing is not a filter change: nothing navigates.
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(window.location.search).toBe("?sortBy=price-asc");
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

  it("updates every value's count to the pending selection and never offers a dead end", async () => {
    document.body.innerHTML = `
      <form data-catalog-filters data-count-endpoint="/categories/footwear/products">
        ${[["option.size", "41", 4], ["option.size", "42", 6], ["option.color", "Black", 7], ["option.color", "Chalk", 1]]
          .map(([name, value, count]) => `
            <label>
              <input type="checkbox" name="${name}" value="${value}" data-catalog-facet />
              <span data-catalog-facet-count>${count}</span>
            </label>`).join("")}
        <button type="submit" data-catalog-filter-apply>Show 10 products</button>
      </form>
    `;
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    setupCatalogFilters();
    const form = document.querySelector("form")!;
    const input = (value: string) => form.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
    const count = (value: string) => input(value).closest("label")!.querySelector("[data-catalog-facet-count]")!.textContent;
    const apply = form.querySelector<HTMLButtonElement>("[data-catalog-filter-apply]")!;
    // The API counts each axis against the other axes' selections; Chalk is
    // not sold in 42, so it is missing from the colour counts.
    const respond = (total: number, facets: unknown[]) => ({
      ok: true,
      json: async () => ({ success: true, data: { pagination: { total }, facets } }),
    });
    const fetchMock = vi.fn().mockResolvedValue(respond(6, [
      facet("option.size", [["41", 4], ["42", 6]]),
      facet("option.color", [["Black", 6]]),
    ]));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    input("42").click();
    await vi.advanceTimersByTimeAsync(300);

    expect([count("41"), count("42"), count("Black"), count("Chalk")]).toEqual(["4", "6", "6", "0"]);
    expect(input("Chalk").disabled).toBe(true);
    expect(input("Black").disabled).toBe(false);
    expect(apply.textContent).toBe("Show 6 products");
    expect(apply.disabled).toBe(false);

    // A selection that already matches nothing stays undoable, and the
    // button says so instead of offering "Show 0 products".
    fetchMock.mockResolvedValue(respond(0, [facet("option.size", [["41", 0], ["42", 0]])]));
    input("Black").click();
    expect(apply.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();

    expect(input("42").disabled).toBe(false);
    expect(input("Black").disabled).toBe(false);
    expect(input("41").disabled).toBe(true);
    expect(apply.textContent).toBe("No matching products");
    expect(apply.disabled).toBe(true);
  });

  it("shows each range's bounds for the pending selection as its placeholders", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="display-size.min" placeholder="11" data-catalog-range="min" />
        <input type="text" name="display-size.max" placeholder="17" data-catalog-range="max" />
        <input type="text" name="weight.min" placeholder="1" data-catalog-range="min" />
        <button type="submit" data-catalog-filter-apply>Show 10 products</button>
      </form>
    `;
    const form = document.querySelector("form")!;
    applyCatalogFilterCounts(form, [rangeFacet("display-size", { min: 13, max: 15.6 }), rangeFacet("weight", null)], 4);
    const placeholders = [...form.querySelectorAll("input")].map((input) => input.placeholder);
    // A range the pending selection leaves without products keeps its old hint.
    expect(placeholders).toEqual(["13", "15.6", "1"]);
    expect(form.querySelector("button")!.textContent).toBe("Show 4 products");
  });

  it("counts the \"N★ & up\" rows for the pending selection", () => {
    document.body.innerHTML = `
      <form>
        <label><input type="radio" name="minRating" value="4" data-catalog-rating /><span data-catalog-facet-count>9</span></label>
        <label><input type="radio" name="minRating" value="3" data-catalog-rating checked /><span data-catalog-facet-count>12</span></label>
        <label><input type="radio" name="minRating" value="2" data-catalog-rating /><span data-catalog-facet-count>15</span></label>
        <label><input type="radio" name="minRating" value="" data-catalog-rating /></label>
        <button type="submit" data-catalog-filter-apply>Show 12 products</button>
      </form>
    `;
    const form = document.querySelector("form")!;
    applyCatalogFilterCounts(form, [], 5, [{ min: 4, count: 0 }, { min: 3, count: 5 }, { min: 2, count: 7 }]);
    const rows = [...form.querySelectorAll<HTMLInputElement>("input[data-catalog-rating]")];
    expect(rows.map((row) => row.closest("label")!.textContent!.trim())).toEqual(["0", "5", "7", ""]);
    expect(rows.map((row) => row.disabled)).toEqual([true, false, false, false]);
  });
});

describe("customer rating rows", () => {
  const facet = [{ min: 4, count: 12 }, { min: 3, count: 18 }, { min: 2, count: 20 }];

  it("offers 4★, 3★ and 2★ & up with their counts once the store has reviews", () => {
    expect(catalogRatingRows(facet, {}, true)).toEqual([
      { min: 4, count: 12, selected: false },
      { min: 3, count: 18, selected: false },
      { min: 2, count: 20, selected: false },
    ]);
    expect(catalogRatingRows(facet, { minRating: "3" }, true).find((row) => row.selected)).toEqual({ min: 3, count: 18, selected: true });
  });

  it("shows nothing while the store has no reviews or nothing in scope has one", () => {
    expect(catalogRatingRows(facet, {}, false)).toEqual([]);
    expect(catalogRatingRows([], {}, true)).toEqual([]);
    expect(catalogRatingRows([{ min: 4, count: 0 }, { min: 3, count: 0 }], {}, true)).toEqual([]);
  });

  it("keeps the buyer's choice so it can be undone, even at zero", () => {
    expect(catalogRatingRows([], { minRating: "4" }, false)).toEqual([{ min: 4, count: 0, selected: true }]);
  });
});
