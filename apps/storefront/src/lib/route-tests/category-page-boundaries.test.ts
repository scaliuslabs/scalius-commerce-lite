import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "../test-source-paths";

const source = readFileSync(
  storefrontSourcePath("pages/categories/[slug].astro"),
  "utf8",
);
const catalogSortSource = readFileSync(
  storefrontSourcePath("lib/catalog-sort.ts"),
  "utf8",
);

describe("category listing page boundaries", () => {
  it("does not attach base-category CollectionPage schema to filtered URLs", () => {
    expect(source).toContain(
      "const hasListingQuery = Astro.url.searchParams.size > 0",
    );
    expect(source).toContain("!hasListingQuery &&");
  });

  it("renders optional buying content only on the canonical listing", () => {
    expect(source).toContain("hasRenderableHtmlContent(categoryContent) &&");
    expect(source).toContain("content={categoryContent}");
    expect(source).toContain("processShortcodes={false}");
  });

  it("distinguishes an empty category from an empty filtered result", () => {
    expect(source).toContain("No products match these filters");
    expect(source).toContain("No products in this category yet");
    expect(source).toContain("Browse all products");
  });

  it("binds sort navigation once across Astro lifecycle events", () => {
    expect(source).toContain("setupCatalogSorts");
    expect(catalogSortSource).toContain(
      'if (sortSelect.dataset.sortBound === "true") return',
    );
    expect(catalogSortSource).toContain(
      'sortSelect.dataset.sortBound = "true"',
    );
  });
});
