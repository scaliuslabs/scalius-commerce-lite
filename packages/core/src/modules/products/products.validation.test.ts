import { describe, expect, it } from "vitest";
import { createProductSchema, updateProductSchema } from "./products.validation";
import {
    bulkCreateVariantsSchema,
    bulkDeleteVariantsSchema,
    createVariantSchema,
    updateSortOrderSchema,
    updateVariantSchema,
    variantEditPlanSchema,
} from "./products.types";
import {
    DEFAULT_PRODUCT_OPTION_LABELS,
    DEFAULT_PRODUCT_OPTION_SCHEMA,
} from "@scalius/shared/product-options";
import { DEFAULT_PRODUCT_CONDITION } from "@scalius/shared/product-condition";

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
    productCondition: DEFAULT_PRODUCT_CONDITION,
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

    it("accepts only explicit supported product conditions", () => {
        expect(createProductSchema.parse(productInput).productCondition).toBe("new");
        expect(createProductSchema.parse({ ...productInput, productCondition: "used" }).productCondition).toBe("used");
        expect(
            createProductSchema.safeParse({
                ...productInput,
                productCondition: "open-box",
            }).success,
        ).toBe(false);
    });

    it("requires an authoritative aggregate revision on every editor mutation", () => {
        expect(updateProductSchema.safeParse({ ...productInput, id: "prod_1" }).success).toBe(false);
        expect(createVariantSchema.safeParse({}).success).toBe(false);
        expect(updateVariantSchema.safeParse({}).success).toBe(false);
        expect(bulkCreateVariantsSchema.safeParse({ variants: [] }).success).toBe(false);
        expect(bulkDeleteVariantsSchema.safeParse({ variantIds: ["var_1"] }).success).toBe(false);
        expect(variantEditPlanSchema.safeParse({ creates: [], updates: [{ id: "var_1", price: 1 }] }).success).toBe(false);
        expect(updateSortOrderSchema.safeParse({ colors: [], sizes: [] }).success).toBe(false);

        expect(updateProductSchema.safeParse({
            ...productInput,
            id: "prod_1",
            expectedAggregateRevision: 3,
        }).success).toBe(true);
    });
});
