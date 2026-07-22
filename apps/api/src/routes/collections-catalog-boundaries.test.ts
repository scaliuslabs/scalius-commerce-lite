import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./collections.ts", import.meta.url).pathname,
  "utf8",
);

describe("public collection catalog route", () => {
  it("uses the paginated buyer catalog model with repeated facet filters", () => {
    expect(source).toContain("getPublicCollectionCatalog");
    expect(source).toContain("collectionCatalogQuerySchema");
    expect(source).toContain("readRepeatedPublicQueryValues(c.req.url)");
    expect(source).toContain("resolvePublicAttributeFilters(");
    expect(source).toContain('sort: z.enum([');
    for (const sort of [
      "newest",
      "price-asc",
      "price-desc",
      "name-asc",
      "name-desc",
      "discount",
    ]) {
      expect(source).toContain(`"${sort}"`);
    }
    expect(source).toContain("pagination: paginationSchema");
    expect(source).toContain("facets: z.array(collectionFacetSchema)");
    expect(source).toContain("priceRange: z.object");
    expect(source).not.toContain("resolveCollectionProducts(db, config)");
  });

  it("keeps collection absence authoritative and operational errors typed by middleware", () => {
    expect(source).toContain('if (!result) {\n    throw new NotFoundError("Collection not found")');
    expect(source).toContain("404: errorResponses[404]");
    expect(source).toContain("500: errorResponses[500]");
  });

  it("keeps long editorial copy on detail responses only", () => {
    const listProjection = source.slice(
      source.indexOf("const activeCollections = await db"),
      source.indexOf("const formattedCollections ="),
    );

    expect(source).toContain("const storefrontCollectionDetailSchema =");
    expect(source).toContain("collection: storefrontCollectionDetailSchema");
    expect(listProjection).not.toContain("description: collections.description");
    expect(listProjection).not.toContain("content: collections.content");
  });
});
