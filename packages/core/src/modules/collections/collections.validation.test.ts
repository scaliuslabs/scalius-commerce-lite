import { describe, expect, it } from "vitest";
import { createCollectionSchema, updateCollectionSchema } from "./collections.validation";

describe("collection validation", () => {
    it("does not clear canonical path on unrelated partial updates", () => {
        const parsed = updateCollectionSchema.parse({ isActive: false });

        expect(parsed).toEqual({ isActive: false });
    });

    it("keeps collection config updates partial instead of defaulting membership", () => {
        const parsed = updateCollectionSchema.parse({
            config: { title: "New heading" },
        });

        expect(parsed).toEqual({ config: { title: "New heading" } });
    });

    it("normalizes blank canonical path updates to null", () => {
        const parsed = updateCollectionSchema.parse({ canonicalPath: "   " });

        expect(parsed).toEqual({ canonicalPath: null });
    });

    it("accepts collection-shaped canonical overrides", () => {
        const parsed = updateCollectionSchema.parse({
            canonicalPath: " /collections/col_1 ",
        });

        expect(parsed).toEqual({ canonicalPath: "/collections/col_1" });
    });

    it("rejects canonical overrides that are not collection routes", () => {
        for (const canonicalPath of [
            "/featured/summer",
            "/collections/summer/edit",
            "/collections/summer-edit",
            "/categories/summer-edit",
        ]) {
            expect(
                updateCollectionSchema.safeParse({ canonicalPath }).success,
                canonicalPath,
            ).toBe(false);
        }
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
});
