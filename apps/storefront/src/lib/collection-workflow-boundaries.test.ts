import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const collectionPage = readFileSync(
  storefrontSourcePath("pages/collections/[id].astro"),
  "utf8",
);
const grid = readFileSync(
  storefrontSourcePath("components/collection1.astro"),
  "utf8",
);
const carousel = readFileSync(
  storefrontSourcePath("components/sliders/ProductCarousel.tsx"),
  "utf8",
);

describe("collection storefront workflow boundaries", () => {
  it("uses the authoritative total and exposes an accessible mobile filter dialog", () => {
    expect(collectionPage).toContain("{pagination.total} products");
    expect(collectionPage).toContain('aria-controls="collection-filter-section"');
    expect(collectionPage).toContain('toggle.setAttribute("aria-expanded", "true")');
    expect(collectionPage).toContain('role="dialog"');
  });

  it("links both homepage presentations to the collection route", () => {
    for (const source of [grid, carousel]) {
      expect(source).toContain("/collections/${encodeURIComponent(collection.id)}");
      expect(source).toContain("View collection");
    }
  });

  it("places the grid lead product first without exceeding the homepage limit", () => {
    expect(grid).toContain("collection.featuredProduct");
    expect(grid).toContain(".slice(0, config.maxProducts || 8)");
  });

  it("does not autoplay the carousel for reduced-motion users", () => {
    expect(carousel).toContain('prefers-reduced-motion: reduce');
  });
});
