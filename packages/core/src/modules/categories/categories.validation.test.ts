import { describe, expect, it } from "vitest";
import {
    createCategorySchema,
    updateCategorySchema,
    updateCategoryStatusSchema,
} from "./categories.validation";

const categoryInput = {
    name: "Summer Shoes",
    description: null,
    content: null,
    slug: "summer-shoes",
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    image: null,
};

describe("category validation", () => {
    it("accepts category-shaped canonical overrides", () => {
        const parsed = createCategorySchema.parse({
            ...categoryInput,
            canonicalPath: " /categories/summer-shoes ",
        });

        expect(parsed.canonicalPath).toBe("/categories/summer-shoes");
    });

    it("rejects canonical overrides that are not category routes", () => {
        for (const canonicalPath of [
            "/shop/summer-shoes",
            "/categories/summer/shoes",
            "/products/summer-shoes",
        ]) {
            expect(
                createCategorySchema.safeParse({
                    ...categoryInput,
                    canonicalPath,
                }).success,
                canonicalPath,
            ).toBe(false);
        }
    });

    it("rejects another category's canonical handle until alias routing exists", () => {
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            canonicalPath: "/categories/different-category",
        }).success).toBe(false);
    });

    it("rejects unsafe category image sources", () => {
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            image: {
                id: "image_1",
                url: "javascript:alert(1)",
                filename: "image.jpg",
                size: 100,
                createdAt: new Date(),
            },
        }).success).toBe(false);
    });

    it("normalizes bounded merchant text at the API boundary", () => {
        const parsed = createCategorySchema.parse({
            ...categoryInput,
            name: "  Summer Shoes  ",
            content: "  <h2>Choose the right pair</h2>  ",
            metaTitle: "   ",
            metaDescription: "  A summer edit  ",
        });

        expect(parsed.name).toBe("Summer Shoes");
        expect(parsed.content).toBe("<h2>Choose the right pair</h2>");
        expect(parsed.metaTitle).toBeNull();
        expect(parsed.metaDescription).toBe("A summer edit");
    });

    it("rejects unbounded discovery copy and invalid image metadata", () => {
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            metaTitle: "x".repeat(71),
        }).success).toBe(false);
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            metaDescription: "x".repeat(201),
        }).success).toBe(false);
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            content: "x".repeat(100_001),
        }).success).toBe(false);
        expect(createCategorySchema.safeParse({
            ...categoryInput,
            image: {
                id: "image_1",
                url: "/category.jpg",
                filename: "category.jpg",
                size: -1,
                createdAt: "not-a-date",
            },
        }).success).toBe(false);
    });

    it("requires one canonical status and a positive revision for edits", () => {
        expect(updateCategorySchema.parse({
            ...categoryInput,
            status: "internal",
            expectedRevision: 4,
        })).toMatchObject({ status: "internal", expectedRevision: 4 });
        expect(updateCategoryStatusSchema.safeParse({
            status: "private",
            expectedRevision: 4,
        }).success).toBe(false);
        expect(updateCategoryStatusSchema.safeParse({
            status: "published",
            expectedRevision: 0,
        }).success).toBe(false);
    });
});
