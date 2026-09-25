// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { setupCatalogSorts } from "./catalog-sort";

describe("catalog sorting", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select
        data-catalog-sort
        data-list-pathname="/collections/carry"
        data-current-filters='{"brand":["Orbit Works"],"q":"  desk   lamp ","page":"3"}'
      >
        <option value="newest">Featured</option>
        <option value="price-asc" selected>Price: Low to High</option>
      </select>
    `;
    window.history.replaceState({}, "", "/collections/carry");
  });

  it("preserves canonical filters, normalizes search, and returns to page one", () => {
    setupCatalogSorts();
    const select = document.querySelector<HTMLSelectElement>(
      "[data-catalog-sort]",
    )!;

    select.dispatchEvent(new Event("change"));

    expect(window.location.pathname).toBe("/collections/carry");
    expect(window.location.search).toBe(
      "?brand=Orbit+Works&q=desk+lamp&sortBy=price-asc",
    );
  });

  it("keeps the search page's default relevance order out of the URL", () => {
    document.body.innerHTML = `
      <select data-catalog-sort data-list-pathname="/search" data-default-sort="relevance"
        data-current-filters='{"q":"bag","sortBy":"price-asc"}'>
        <option value="relevance" selected>Best match</option>
      </select>
    `;
    setupCatalogSorts();

    document.querySelector("select")!.dispatchEvent(new Event("change"));

    expect(window.location.pathname).toBe("/search");
    expect(window.location.search).toBe("?q=bag");
  });

  it("changes the page size from page one, keeping sort and filters; the default size leaves the URL", () => {
    document.body.innerHTML = `
      <select name="limit" data-catalog-sort data-list-pathname="/categories/bags"
        data-current-filters='{"color":["Red"],"sortBy":"price-asc","page":"4"}'>
        <option value="20">20</option><option value="60" selected>60</option>
      </select>
    `;
    setupCatalogSorts();
    const select = document.querySelector("select")!;

    select.dispatchEvent(new Event("change"));
    expect(window.location.search).toBe("?color=Red&limit=60&sortBy=price-asc");

    select.value = "20";
    select.dispatchEvent(new Event("change"));
    expect(window.location.search).toBe("?color=Red&sortBy=price-asc");
  });

  it("binds each rendered select only once", () => {
    setupCatalogSorts();
    setupCatalogSorts();

    expect(
      document.querySelector<HTMLSelectElement>("[data-catalog-sort]")!
        .dataset.sortBound,
    ).toBe("true");
  });
});
