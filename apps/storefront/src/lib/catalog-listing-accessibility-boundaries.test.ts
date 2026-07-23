import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const sourceRoot = storefrontSourcePath();

const pagination = readFileSync(
  `${sourceRoot}/components/catalog/CatalogPagination.astro`,
  "utf8",
);
const category = readFileSync(
  `${sourceRoot}/pages/categories/[slug].astro`,
  "utf8",
);
const search = readFileSync(
  `${sourceRoot}/pages/search/index.astro`,
  "utf8",
);
const collection = readFileSync(
  `${sourceRoot}/pages/collections/[id].astro`,
  "utf8",
);

describe("shared catalog listing accessibility", () => {
  it("uses non-focusable disabled pagination and named chevron controls", () => {
    expect(pagination).not.toContain('href="#"');
    expect(pagination.match(/aria-label="Previous page"/g)).toHaveLength(2);
    expect(pagination.match(/aria-label="Next page"/g)).toHaveLength(2);
    expect(pagination).toContain("<button");
    expect(pagination).toContain("disabled");
    expect(pagination).toContain('aria-hidden="true"');
    expect(pagination).not.toContain('aria-disabled="true"');
  });

  it("shares one accessible pagination implementation across catalog routes", () => {
    for (const source of [category, search, collection]) {
      expect(source).toContain("CatalogPagination");
    }
    expect(collection).not.toContain("Page {pagination.page} of {pagination.totalPages}");
  });

  it.each([category, search])("shares one modal filter behavior", (source) => {
    expect(source).toContain("CatalogPagination");
    expect(source).toContain("setupCatalogFilterDialog");
    expect(source).toContain('aria-controls="filter-section"');
    expect(source).toContain('aria-label="Close filters"');
    expect(source).not.toContain("function setupFilterInteractivity");
    expect(source).not.toContain("function generatePaginationLinks");
  });

  it("keeps search result copy grammatical and visually consistent with catalog pages", () => {
    expect(search).toContain('pagination.total === 1 ? "result" : "results"');
    expect(search).toContain('pagination.total === 1 ? "product" : "products"');
    expect(search).toContain('{query ? "Search results" : "All products"}');
    expect(search).toContain("{!query && (");
    expect(search).not.toContain('query ? "Search Results" : "Explore Our Products"');
    expect(search).not.toContain('class="text-center mb-6 bg-white rounded-lg p-6');
  });

  it.each([category, search, collection])("uses singular product labels for one-item catalogs", (source) => {
    expect(source).toContain('pagination.total === 1 ? "product" : "products"');
    expect(source).not.toContain("{pagination.total} products");
  });
});
