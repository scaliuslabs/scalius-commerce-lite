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

describe("shared catalog listing accessibility", () => {
  it("uses non-focusable disabled pagination and named controls", () => {
    expect(pagination).not.toContain('href="#"');
    expect(pagination).toContain('aria-label="Previous page"');
    expect(pagination).toContain('aria-label="Next page"');
    expect(pagination).toContain('aria-disabled="true"');
  });

  it.each([category, search])("shares one pagination and modal filter behavior", (source) => {
    expect(source).toContain("CatalogPagination");
    expect(source).toContain("setupCatalogFilterDialog");
    expect(source).toContain('aria-controls="filter-section"');
    expect(source).toContain('aria-label="Close filters"');
    expect(source).not.toContain("function setupFilterInteractivity");
    expect(source).not.toContain("function generatePaginationLinks");
  });
});
