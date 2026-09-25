// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/transport", () => ({ createApiUrl: (path: string) => `https://api.test/api/v1${path}` }));

import type { ProductFacet } from "@/lib/api";
import {
  applyCatalogFilterCounts,
  catalogCountQuery,
  catalogFilterSearchParams,
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

    expect(color!.preview.map(({ value, count }) => [value, count])).toEqual([["Black", 2], ["Chalk", 0]]);
  });

  it("folds long value lists after ten and marks selected values", () => {
    const many = facet("size", Array.from({ length: 13 }, (_, index): [string, number] => [`${36 + index}`, 1]));
    const [shown] = visibleCatalogFacets([many], { size: ["48"] });

    expect(shown!.preview).toHaveLength(10);
    expect(shown!.more.map(({ value, selected }) => [value, selected])).toEqual([
      ["46", false], ["47", false], ["48", true],
    ]);
  });

  it("shows a range when its products differ, or while a bound is applied", () => {
    const facets = [rangeFacet("display-size", { min: 13, max: 15.6 }), rangeFacet("weight", { min: 1.2, max: 1.2 }), rangeFacet("battery", null)];
    const [shown, ...rest] = visibleCatalogFacets(facets, {});
    expect([shown!.slug, rest]).toEqual(["display-size", []]);
    expect(shown).toMatchObject({ applied: { min: null, max: null }, selectedCount: 0, preview: [], more: [] });

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
    expect(shown!.preview.map(({ label, selected }) => [label, selected])).toEqual([["Samsung", true], ["Apple", false]]);
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

  it("narrows a long facet list as the buyer types, without submitting", () => {
    document.body.innerHTML = `
      <form data-catalog-filters>
        <fieldset>
          <div data-catalog-facet-search hidden>
            <input type="search" data-catalog-facet-query />
            <p data-catalog-facet-search-empty hidden>No matches</p>
          </div>
          ${[["asus", "Asus", 3], ["acer", "Acer", 1], ["hp", "Hewlett-Packard", 2]].map(([value, label, count]) => `<label><input type="checkbox" name="brand" value="${value}" data-catalog-facet /><span>${label}</span><span data-catalog-facet-count>${count}</span></label>`).join("")}
          <details><summary>Show 1 more</summary><label><input type="checkbox" name="brand" value="lenovo" data-catalog-facet /><span>Lenovo</span><span data-catalog-facet-count>4</span></label></details>
        </fieldset>
      </form>
    `;
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    setupCatalogFilters();
    const box = document.querySelector<HTMLElement>("[data-catalog-facet-search]")!;
    const input = box.querySelector("input")!;
    expect(box.hidden).toBe(false);

    const visible = () => [...document.querySelectorAll<HTMLLabelElement>("fieldset label")]
      .filter((label) => !label.hidden)
      .map((label) => label.querySelector("span")!.textContent);
    input.value = "LEN";
    input.dispatchEvent(new Event("input"));
    expect(visible()).toEqual(["Lenovo"]);
    expect(document.querySelector("details")!.open).toBe(true);

    // It searches what the buyer reads: the label, never the URL value or the count.
    input.value = "packard";
    input.dispatchEvent(new Event("input"));
    expect(visible()).toEqual(["Hewlett-Packard"]);
    input.value = "3";
    input.dispatchEvent(new Event("input"));
    expect(visible()).toEqual([]);

    input.value = "zz";
    input.dispatchEvent(new Event("input"));
    expect(visible()).toEqual([]);
    expect(box.querySelector<HTMLElement>("[data-catalog-facet-search-empty]")!.hidden).toBe(false);

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(visible()).toHaveLength(4);
    expect(document.querySelector("details")!.open).toBe(false);

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
});
