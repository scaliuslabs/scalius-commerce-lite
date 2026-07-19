import { describe, expect, it } from "vitest";
import { createCollectionSchema, updateCollectionSchema } from "./collections.validation";

describe("collection validation", () => {
    it("does not clear canonical path on unrelated partial updates", () => {
        const parsed = updateCollectionSchema.parse({ expectedVersion: 3, isActive: false });

        expect(parsed).toEqual({ expectedVersion: 3, isActive: false });
    });

    it("keeps collection config updates partial instead of defaulting membership", () => {
        const parsed = updateCollectionSchema.parse({
            expectedVersion: 3,
            config: { title: "New heading" },
        });

        expect(parsed).toEqual({ expectedVersion: 3, config: { title: "New heading" } });
    });

    it("keeps homepage placement independent and defaults new collections off", () => {
        const update = updateCollectionSchema.parse({
            expectedVersion: 3,
            config: { showOnHomepage: true },
        });
        expect(update).toEqual({ expectedVersion: 3, config: { showOnHomepage: true } });

        const created = createCollectionSchema.parse({
            name: "Private landing collection",
            presentation: "grid",
            isActive: false,
            config: { source: "manual" },
        });
        expect(created.config.showOnHomepage).toBe(false);
    });

    it("normalizes blank canonical path updates to null", () => {
        const parsed = updateCollectionSchema.parse({ expectedVersion: 3, canonicalPath: "   " });

        expect(parsed).toEqual({ expectedVersion: 3, canonicalPath: null });
    });

    it("accepts collection-shaped canonical overrides", () => {
        const parsed = updateCollectionSchema.parse({
            expectedVersion: 3,
            canonicalPath: " /collections/col_1 ",
        });

        expect(parsed).toEqual({ expectedVersion: 3, canonicalPath: "/collections/col_1" });
    });

    it("rejects canonical overrides that are not collection routes", () => {
        for (const canonicalPath of [
            "/featured/summer",
            "/collections/summer/edit",
            "/collections/summer-edit",
            "/categories/summer-edit",
        ]) {
            expect(
                updateCollectionSchema.safeParse({ expectedVersion: 3, canonicalPath }).success,
                canonicalPath,
            ).toBe(false);
        }
    });

    it("requires a positive optimistic concurrency token for every edit", () => {
        expect(updateCollectionSchema.safeParse({ name: "Updated" }).success).toBe(false);
        expect(updateCollectionSchema.safeParse({ expectedVersion: 0, name: "Updated" }).success).toBe(false);
        expect(updateCollectionSchema.safeParse({ expectedVersion: 1, name: "Updated" }).success).toBe(true);
    });

    it("requires the selected membership source before publication", () => {
        const base = {
            name: "Summer edit",
            presentation: "grid" as const,
            isActive: true,
            config: {
                source: "manual" as const,
                categoryIds: [],
                productIds: [],
                maxProducts: 8,
            },
        };

        expect(createCollectionSchema.safeParse(base).success).toBe(false);
        expect(createCollectionSchema.safeParse({
            ...base,
            config: { ...base.config, productIds: ["prod_1"] },
        }).success).toBe(true);
        expect(createCollectionSchema.safeParse({
            ...base,
            config: {
                ...base.config,
                source: "dynamic",
                categoryIds: ["cat_1"],
            },
        }).success).toBe(true);
    });

    it("rejects category IDs in manual product references", () => {
        const config = {
            source: "manual" as const,
            categoryIds: [],
            productIds: ["cat_footwear"],
            maxProducts: 8,
        };

        expect(createCollectionSchema.safeParse({
            name: "Footwear picks",
            presentation: "grid",
            isActive: false,
            config,
        }).success).toBe(false);
        expect(updateCollectionSchema.safeParse({
            expectedVersion: 3,
            config: { productIds: config.productIds },
        }).success).toBe(false);
    });
});
