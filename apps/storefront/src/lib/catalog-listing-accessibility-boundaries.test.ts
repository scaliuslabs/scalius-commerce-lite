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
  it.each([pagination, collection])(
    "uses non-focusable disabled pagination and named chevron controls",
    (source) => {
      expect(source).not.toContain('href="#"');
      expect(source.match(/aria-label="Previous page"/g)).toHaveLength(2);
      expect(source.match(/aria-label="Next page"/g)).toHaveLength(2);
      expect(source).toContain("<button");
      expect(source).toContain("disabled");
      expect(source).toContain('aria-hidden="true"');
      expect(source).not.toContain('aria-disabled="true"');
    },
  );

  it("keeps collection pagination local so its compact page counter layout is unchanged", () => {
    expect(collection).toContain("Page {pagination.page} of {pagination.totalPages}");
    expect(collection).not.toContain("CatalogPagination");
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
