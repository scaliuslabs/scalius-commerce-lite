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

  it("binds each rendered select only once", () => {
    setupCatalogSorts();
    setupCatalogSorts();

    expect(
      document.querySelector<HTMLSelectElement>("[data-catalog-sort]")!
        .dataset.sortBound,
    ).toBe("true");
  });
});
