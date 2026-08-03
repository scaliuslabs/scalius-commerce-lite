import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("attribute route query boundaries", () => {
  it("derives search filters from the exact buyer-visible search hit set", () => {
    const source = readFileSync(`${ROUTES_DIR}/attributes.ts`, "utf8");

    const routeIndex = source.indexOf("const searchFiltersRoute = createRoute");
    const helperCallIndex = source.indexOf("getPublicAttributesForSearch(db, query, categoryId)", routeIndex);

    expect(helperCallIndex).toBeGreaterThan(routeIndex);
    expect(source).toContain("const query = normalizePublicFtsSearchQuery(q);");
    expect(source).not.toContain("matchingCategories");
    expect(source).not.toContain("inArray(products.categoryId");
    expect(source).not.toContain(".limit(100)");
  });

});
