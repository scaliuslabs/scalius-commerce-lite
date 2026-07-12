import { describe, expect, it } from "vitest";
import { createCategorySchema } from "./categories.validation";

const categoryInput = {
    name: "Summer Shoes",
    description: null,
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
});
