import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public attribute query boundaries", () => {
    const source = readFileSync(new URL("./attributes.public.ts", import.meta.url), "utf8");

    it("keeps search facets on exact FTS-matched buyer-visible products", () => {
        const searchHelper = source.slice(source.indexOf("export async function getPublicAttributesForSearch"));

        expect(searchHelper).toContain('ftsMatch(db, "products_fts", "products", search)');
        expect(searchHelper).toContain("publicProductHasBuyerResolvableSku()");
        expect(searchHelper).toContain("searchCondition");
        expect(searchHelper).not.toContain("matchingCategories");
    });

    it("uses JSON lookup sets instead of unbounded ID bind lists", () => {
        expect(source).toContain("FROM json_each(${attributeIdsJson})");
        expect(source).toContain("FROM json_each(${productIdsJson})");
    });

    it("bounds every public facet query and grouped response", () => {
        expect(source.match(/\.limit\(PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT\)/g))
            .toHaveLength(4);
        expect(source).toContain("PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT = 50");
        expect(source).toContain("PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT = 100");
        expect(source).toContain("PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT = 2_000");
        expect(source).toContain("attributeMap.size >= PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT");
        expect(source).toContain("values.size < PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT");
    });
});
