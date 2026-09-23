import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CategoryFilters from "./CategoryFilters";

describe("buyer catalog facet controls", () => {
  it("hydrates an unfiltered category from its authoritative API price range", () => {
    const html = renderToStaticMarkup(createElement(CategoryFilters, {
      facets: [],
      currentFilters: {},
      priceRange: { min: 50, max: 7_055 },
    }));
    const minInput = html.match(/<input[^>]+id="catalog-min-price"[^>]*>/)?.[0];
    const maxInput = html.match(/<input[^>]+id="catalog-max-price"[^>]*>/)?.[0];

    expect(minInput).toContain('value="50"');
    expect(maxInput).toContain('value="7055"');
  });

  it("does not offer a dead reset action until a filter is active", () => {
    const unfilteredHtml = renderToStaticMarkup(createElement(CategoryFilters, {
      facets: [],
      currentFilters: {},
      resetPath: "/collections/everyday-carry",
      priceRange: { min: 50, max: 7_055 },
    }));
    const filteredHtml = renderToStaticMarkup(createElement(CategoryFilters, {
      facets: [],
      currentFilters: { hasDiscount: "true" },
      resetPath: "/collections/everyday-carry",
      priceRange: { min: 50, max: 7_055 },
    }));

    expect(unfilteredHtml).not.toContain("Clear all");
    expect(unfilteredHtml).toContain("Show products");
    expect(unfilteredHtml).toContain("grid-cols-1");
    expect(filteredHtml).toContain("Clear all");
    expect(filteredHtml).toContain("grid-cols-2");
  });
});
