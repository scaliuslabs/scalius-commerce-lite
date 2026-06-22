import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoFile(path: string): string {
    return readFileSync(`${REPO_ROOT}/${path}`, "utf8");
}

describe("public product eligibility boundaries", () => {
    it("keeps global search and attribute filters behind buyer-resolvable SKU predicates", () => {
        const searchSource = readRepoFile("packages/core/src/search/index.ts");
        const attributesSource = readRepoFile("packages/core/src/modules/attributes/attributes.public.ts");

        expect(searchSource).toContain("publicProductBaseConditions");
        expect(searchSource).toContain("const productConditions: SQL[] = publicProductBaseConditions();");
        expect(attributesSource).toContain("publicProductHasBuyerResolvableSku");
        expect(attributesSource.match(/publicProductHasBuyerResolvableSku\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it("keeps collection and homepage product resolution behind buyer-resolvable SKU predicates", () => {
        const collectionsSource = readRepoFile("packages/core/src/modules/collections/collections.service.ts");

        expect(collectionsSource).toContain("publicCollectionProductConditions");
        expect(collectionsSource.match(/publicCollectionProductConditions\(/g)?.length).toBeGreaterThanOrEqual(6);
        expect(collectionsSource).not.toContain("eq(products.isActive, true), isNull(products.deletedAt)");
    });
});
