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
const productCard = readFileSync(
  storefrontSourcePath("components/cards/ProductCard.astro"),
  "utf8",
);

describe("collection storefront workflow boundaries", () => {
  it("uses the authoritative total and exposes an accessible mobile filter dialog", () => {
    expect(collectionPage).toContain("{pagination.total}");
    expect(collectionPage).toContain(
      'pagination.total === 1 ? "product" : "products"',
    );
    expect(collectionPage).toContain(
      'aria-controls="collection-filter-section"',
    );
    expect(collectionPage).toContain("setupCatalogFilterDialog");
    expect(collectionPage).toContain('dialogId: "collection-filter-section"');
    expect(collectionPage).not.toContain('aria-modal="true"');
  });

  it("keeps collection filters and shopper sorting in one responsive workflow", () => {
    expect(collectionPage).toContain("const sortBy = queryState.sortBy");
    expect(collectionPage).toContain("data-catalog-sort");
    expect(collectionPage).toContain(
      '<input type="hidden" name="sortBy" value={sortBy} />',
    );
    expect(collectionPage).toContain("setupCatalogSorts");
    expect(collectionPage).toContain("grid grid-cols-2 gap-2 rounded-xl");
    expect(collectionPage).toContain("shadow-sm lg:flex");
    expect(collectionPage).not.toContain("shadow-sm sm:flex");
    expect(collectionPage).toContain('value="discount"');
  });

  it("separates collection identity, search metadata, and canonical-only editorial content", () => {
    expect(collectionPage).toContain(
      "const title = collection.metaTitle || collection.name",
    );
    expect(collectionPage).toContain(
      "const plainDescription = htmlToPlainText(collection.description)",
    );
    expect(collectionPage).toContain("{collection.name}");
    expect(collectionPage).toContain(
      "hasRenderableHtmlContent(collectionContent) &&",
    );
    expect(collectionPage).toContain("content={collectionContent}");
    expect(collectionPage).toContain("processShortcodes={false}");
    expect(collectionPage).toContain("!hasListingQuery &&");
    expect(collectionPage).not.toContain("config.title || collection.name");
  });

  it("links both homepage presentations to the collection route", () => {
    for (const source of [grid, carousel]) {
      expect(source).toContain(
        "/collections/${encodeURIComponent(collection.id)}",
      );
      expect(source).toContain("View collection");
    }
  });

  it("places the grid lead product first without exceeding the homepage limit", () => {
    expect(grid).toContain("collection.featuredProduct");
    expect(grid).toContain(".slice(0, config.maxProducts || 8)");
  });

  it("does not autoplay the carousel for reduced-motion users", () => {
    expect(carousel).toContain("prefers-reduced-motion: reduce");
  });

  it("uses the shared short money formatter across homepage presentations", () => {
    for (const source of [productCard, carousel]) {
      expect(source).toContain("formatPriceShort");
      expect(source).not.toContain("discountedPrice.toLocaleString()");
      expect(source).not.toContain("price.toLocaleString()");
    }
    expect(carousel).toContain(
      'const pricePrefix = product.priceVaries ? "From " : "";',
    );
    expect(carousel).toContain(
      "{pricePrefix}{formatMoney(product.discountedPrice)}",
    );
  });
});
