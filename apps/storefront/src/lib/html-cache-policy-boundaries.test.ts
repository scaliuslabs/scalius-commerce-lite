import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STOREFRONT_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("storefront HTML cache policy boundaries", () => {
  it("keeps collection detail pages in the exact HTML cache lane", () => {
    const source = readFileSync(
      `${STOREFRONT_SRC_ROOT}/middleware.ts`,
      "utf8",
    );

    const cacheablePathsIndex = source.indexOf("const CACHEABLE_PATHS = [");
    const productsIndex = source.indexOf("/^\\/products\\/[^/]+$/", cacheablePathsIndex);
    const categoriesIndex = source.indexOf("/^\\/categories\\/[^/]+$/", cacheablePathsIndex);
    const collectionsIndex = source.indexOf("/^\\/collections\\/[^/]+$/", cacheablePathsIndex);
    const searchIndex = source.indexOf("/^\\/search\\/?$/", cacheablePathsIndex);

    expect(cacheablePathsIndex).toBeGreaterThan(-1);
    expect(productsIndex).toBeGreaterThan(cacheablePathsIndex);
    expect(categoriesIndex).toBeGreaterThan(productsIndex);
    expect(collectionsIndex).toBeGreaterThan(categoriesIndex);
    expect(searchIndex).toBeGreaterThan(collectionsIndex);
  });
});
