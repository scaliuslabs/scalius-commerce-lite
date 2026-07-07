import { describe, expect, it } from "vitest";
import { createProductSchema } from "./products.validation";
import {
    DEFAULT_PRODUCT_OPTION_LABELS,
    DEFAULT_PRODUCT_OPTION_SCHEMA,
} from "@scalius/shared/product-options";

const productInput = {
    name: "Main Shoe",
    description: "Comfortable everyday shoe.",
    price: 1200,
    categoryId: "cat_1",
    isActive: true,
    discountType: "percentage",
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    variantOption1Label: DEFAULT_PRODUCT_OPTION_LABELS.option1,
    variantOption2Label: DEFAULT_PRODUCT_OPTION_LABELS.option2,
    variantOption1Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
    variantOption2Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
    slug: "main-shoe",
    images: [],
    attributes: [],
    additionalInfo: [],
};

describe("product validation", () => {
    it("accepts product-shaped canonical overrides", () => {
        const parsed = createProductSchema.parse({
            ...productInput,
            canonicalPath: " /products/main-shoe ",
        });

        expect(parsed.canonicalPath).toBe("/products/main-shoe");
    });

    it("rejects canonical overrides that are not product routes", () => {
        for (const canonicalPath of [
            "/fish/hilsa",
            "/shop/linen-shirt",
            "/products/main-shoe/details",
        ]) {
            expect(
                createProductSchema.safeParse({
                    ...productInput,
                    canonicalPath,
                }).success,
                canonicalPath,
            ).toBe(false);
        }
    });
});
