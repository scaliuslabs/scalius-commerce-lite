import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../pages/categories/[slug].astro", import.meta.url)),
  "utf8",
);

describe("category listing page boundaries", () => {
  it("does not attach base-category CollectionPage schema to filtered URLs", () => {
    expect(source).toContain("const hasListingQuery = Astro.url.searchParams.size > 0");
    expect(source).toContain("!hasListingQuery &&");
  });

  it("distinguishes an empty category from an empty filtered result", () => {
    expect(source).toContain("No products match these filters");
    expect(source).toContain("No products in this category yet");
    expect(source).toContain("Browse all products");
  });

  it("binds sort navigation once across Astro lifecycle events", () => {
    expect(source).toContain('if (sortSelect.dataset.sortBound === "true") return');
    expect(source).toContain('sortSelect.dataset.sortBound = "true"');
  });
});
