import { describe, expect, it } from "vitest";
import {
    COLLECTION_CONFIG_ID_LIMIT,
    collectionMembershipForConfig,
    collectionProductIdsForLookup,
    normalizeCollectionConfig,
    publicCollectionConfig,
    stringifyCollectionConfig,
} from "./collection-config";

describe("collection config normalization", () => {
    it("returns a complete default config for missing or invalid values", () => {
        expect(normalizeCollectionConfig(undefined)).toEqual({
            source: "manual",
            categoryIds: [],
            productIds: [],
            maxProducts: 8,
            title: "",
            subtitle: "",
        });

        expect(normalizeCollectionConfig("{bad json")).toEqual({
            source: "manual",
            categoryIds: [],
            productIds: [],
            maxProducts: 8,
            title: "",
            subtitle: "",
        });
    });

    it("normalizes the canonical config shape and clamps maxProducts", () => {
        expect(normalizeCollectionConfig({
            source: "manual",
            categoryIds: ["cat_1", "", "cat_1"],
            productIds: ["prod_1", " prod_2 ", "prod_1"],
            featuredProductId: " prod_3 ",
            maxProducts: "200",
            title: "Featured",
            subtitle: "Top picks",
        })).toEqual({
            source: "manual",
            categoryIds: ["cat_1"],
            productIds: ["prod_1", "prod_2"],
            featuredProductId: "prod_3",
            maxProducts: 24,
            title: "Featured",
            subtitle: "Top picks",
        });
    });

    it("requires explicit source semantics and isolates the active membership mode", () => {
        expect(normalizeCollectionConfig({ categoryIds: ["cat_1"] }).source).toBe("manual");
        expect(collectionMembershipForConfig({
            source: "dynamic",
            categoryIds: ["cat_1"],
            productIds: ["stale_product"],
        })).toEqual({
            source: "dynamic",
            categoryIds: ["cat_1"],
            productIds: [],
        });
    });

    it("does not interpret retired product-object or compatibility fields", () => {
        expect(normalizeCollectionConfig({
            products: [
                { id: "prod_1", name: "One" },
                { productId: "prod_2" },
                " prod_3 ",
                { id: "" },
                null,
                "prod_1",
            ],
            specificProductIds: ["prod_legacy"],
        }).productIds).toEqual([]);
    });

    it("serializes canonical storage shape and builds product lookup ids", () => {
        const config = stringifyCollectionConfig({
            source: "manual",
            productIds: ["prod_1", "prod_1"],
            featuredProductId: "prod_2",
            maxProducts: 0,
        });

        expect(JSON.parse(config)).toEqual({
            source: "manual",
            categoryIds: [],
            productIds: ["prod_1"],
            featuredProductId: "prod_2",
            maxProducts: 1,
            title: "",
            subtitle: "",
        });
        expect(collectionProductIdsForLookup(config)).toEqual(["prod_1", "prod_2"]);
    });

    it("bounds canonical ID arrays below the D1 statement parameter ceiling", () => {
        const config = normalizeCollectionConfig({
            categoryIds: Array.from({ length: 120 }, (_, index) => `cat_${index}`),
            productIds: Array.from({ length: 120 }, (_, index) => `prod_${index}`),
        });

        expect(config.categoryIds).toHaveLength(COLLECTION_CONFIG_ID_LIMIT);
        expect(config.productIds).toHaveLength(COLLECTION_CONFIG_ID_LIMIT);
        expect(config.categoryIds.at(-1)).toBe("cat_89");
        expect(config.productIds.at(-1)).toBe("prod_89");
    });

    it("projects display settings without exposing internal membership IDs", () => {
        expect(publicCollectionConfig({
            source: "dynamic",
            categoryIds: ["cat_private"],
            productIds: ["prod_stale"],
            featuredProductId: "prod_lead",
            maxProducts: 12,
            title: "Summer",
            subtitle: "Fresh arrivals",
        })).toEqual({
            maxProducts: 12,
            title: "Summer",
            subtitle: "Fresh arrivals",
        });
    });
});
