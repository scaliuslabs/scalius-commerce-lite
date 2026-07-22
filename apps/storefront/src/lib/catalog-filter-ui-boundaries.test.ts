import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const filters = readFileSync(
  storefrontSourcePath("components/CategoryFilters.tsx"),
  "utf8",
);
const appliedFilters = readFileSync(
  storefrontSourcePath("components/catalog/AppliedCatalogFilters.astro"),
  "utf8",
);
const category = readFileSync(
  storefrontSourcePath("pages/categories/[slug].astro"),
  "utf8",
);
const search = readFileSync(
  storefrontSourcePath("pages/search/index.astro"),
  "utf8",
);
const collection = readFileSync(
  storefrontSourcePath("pages/collections/[id].astro"),
  "utf8",
);

describe("catalog filter UI boundaries", () => {
  it("uses multi-select checkboxes and progressively discloses large facets", () => {
    expect(filters).toContain('type="checkbox"');
    expect(filters).toContain("facets.slice(0, 3)");
    expect(filters).toContain("attr.values.length > 10");
    expect(filters).toContain("Show less");
    expect(filters).not.toContain("aria-pressed={selected}");
  });

  it("keeps mobile actions reachable in a full-width filter dialog", () => {
    expect(filters).toContain("safe-area-inset-bottom");
    expect(filters).toContain("Show products");
    expect(filters).not.toContain('finalParams.set("page", "1")');
    for (const source of [category, search, collection]) {
      expect(source).toContain("flex h-full w-full flex-col bg-white");
      expect(source).toContain("z-60");
      expect(source).toContain("lg:z-0");
      expect(source).not.toContain("lg:z-auto");
    }
    for (const source of [category, search, collection]) {
      expect(source).toContain("data-catalog-sort");
      expect(source).toContain('value="name-asc"');
      expect(source).toContain('value="name-desc"');
      expect(source).toContain('value="discount"');
      expect(source).toContain("sticky top-[calc(var(--header-height,3.5rem)+0.5rem)]");
      expect(source).toContain("lg:sticky lg:top-[calc(var(--header-height,4rem)+1rem)]");
    }
  });

  it("lets shoppers search within both category and collection filters", () => {
    expect(category).toContain('name="q"');
    expect(category).toContain('placeholder="Search this category…"');
    expect(collection).toContain('name="q"');
    expect(collection).toContain('placeholder="Search this collection…"');
  });

  it("shows removable applied filters outside the drawer", () => {
    expect(appliedFilters).toContain('aria-label="Applied filters"');
    expect(appliedFilters).toContain("Remove ${filter.label} filter");
    expect(appliedFilters).toContain("Clear all");
    expect(appliedFilters).toContain('`Search: “${value}”`');
    expect(appliedFilters).not.toContain('new Set(["q", "page", "sortBy"])');
    for (const source of [category, search, collection]) {
      expect(source).toContain("AppliedCatalogFilters");
      expect(source).not.toContain("PRODUCT_LIST_NAVIGATION_PARAMS");
    }
  });
});
