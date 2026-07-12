import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));
const UTILS_DIR = fileURLToPath(new URL("../utils/", import.meta.url));

describe("attribute route query boundaries", () => {
  it("derives search filters from the exact buyer-visible search hit set", () => {
    const source = readFileSync(`${ROUTES_DIR}/attributes.ts`, "utf8");

    const cacheIndex = source.indexOf('keyPrefix: "api:attributes:search-filters"');
    const routeIndex = source.indexOf("const searchFiltersRoute = createRoute");
    const helperCallIndex = source.indexOf("getPublicAttributesForSearch(db, query, categoryId)", routeIndex);

    expect(cacheIndex).toBeGreaterThan(-1);
    expect(cacheIndex).toBeLessThan(routeIndex);
    expect(helperCallIndex).toBeGreaterThan(routeIndex);
    expect(source).toContain("queryNormalizers: { q: normalizePublicFtsSearchCacheValue }");
    expect(source).toContain("const query = normalizePublicFtsSearchQuery(q);");
    expect(source).not.toContain("matchingCategories");
    expect(source).not.toContain("inArray(products.categoryId");
    expect(source).not.toContain(".limit(100)");
  });

  it("invalidates cached search filters from both search and attribute cache groups", () => {
    const source = readFileSync(`${UTILS_DIR}/cache-invalidation.ts`, "utf8");

    const searchGroupIndex = source.indexOf("search: {");
    const attributesGroupIndex = source.indexOf("attributes: {");
    const searchPrefixIndex = source.indexOf(
      '"api:attributes:search-filters"',
      searchGroupIndex,
    );
    const attributesPrefixIndex = source.indexOf(
      '"api:attributes:search-filters"',
      attributesGroupIndex,
    );

    expect(searchPrefixIndex).toBeGreaterThan(searchGroupIndex);
    expect(searchPrefixIndex).toBeLessThan(attributesGroupIndex);
    expect(attributesPrefixIndex).toBeGreaterThan(attributesGroupIndex);
  });
});
