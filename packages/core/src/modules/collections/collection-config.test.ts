import { describe, expect, it } from "vitest";
import {
    collectionProductIdsForLookup,
    normalizeCollectionConfig,
    stringifyCollectionConfig,
} from "./collection-config";

describe("collection config normalization", () => {
    it("returns a complete default config for missing or invalid values", () => {
        expect(normalizeCollectionConfig(undefined)).toEqual({
            categoryIds: [],
            productIds: [],
            maxProducts: 8,
            title: "",
            subtitle: "",
        });

        expect(normalizeCollectionConfig("{bad json")).toEqual({
            categoryIds: [],
            productIds: [],
            maxProducts: 8,
            title: "",
            subtitle: "",
        });
    });

    it("normalizes legacy specificProductIds and clamps maxProducts", () => {
        expect(normalizeCollectionConfig({
            categoryIds: ["cat_1", "", "cat_1"],
            specificProductIds: ["prod_1", " prod_2 ", "prod_1"],
            featuredProductId: " prod_3 ",
            maxProducts: "200",
            title: "Featured",
            subtitle: "Top picks",
        })).toEqual({
            categoryIds: ["cat_1"],
            productIds: ["prod_1", "prod_2"],
            featuredProductId: "prod_3",
            maxProducts: 24,
            title: "Featured",
            subtitle: "Top picks",
        });
    });

    it("preserves explicit productIds over the legacy product list", () => {
        expect(normalizeCollectionConfig({
            productIds: ["prod_new"],
            specificProductIds: ["prod_old"],
        }).productIds).toEqual(["prod_new"]);
    });

    it("serializes canonical storage shape and builds product lookup ids", () => {
        const config = stringifyCollectionConfig({
            productIds: ["prod_1", "prod_1"],
            featuredProductId: "prod_2",
            maxProducts: 0,
        });

        expect(JSON.parse(config)).toEqual({
            categoryIds: [],
            productIds: ["prod_1"],
            featuredProductId: "prod_2",
            maxProducts: 1,
            title: "",
            subtitle: "",
        });
        expect(collectionProductIdsForLookup(config)).toEqual(["prod_1", "prod_2"]);
    });
});
