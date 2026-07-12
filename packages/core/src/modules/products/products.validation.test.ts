import { describe, expect, it } from "vitest";
import { createProductSchema, updateProductSchema } from "./products.validation";
import {
    createVariantSchema,
    updateVariantSchema,
} from "./products.types";
import {
    createProductOptionMatrixSchema,
    productOptionMatrixSchema,
} from "./products.option-matrix";
import {
    MAX_PRODUCT_OPTION_COMBINATIONS,
} from "./products.option-model";
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
    slug: "main-shoe",
    media: [],
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

    it("rejects another product's canonical handle until alias routing exists", () => {
        expect(createProductSchema.safeParse({
            ...productInput,
            canonicalPath: "/products/different-product",
        }).success).toBe(false);

        expect(updateProductSchema.safeParse({
            ...productInput,
            id: "prod_1",
            expectedAggregateRevision: 2,
            canonicalPath: "/products/different-product",
        }).success).toBe(false);
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
        expect(productOptionMatrixSchema.safeParse({ options: [], variants: [] }).success).toBe(false);

        expect(updateProductSchema.safeParse({
            ...productInput,
            id: "prod_1",
            expectedAggregateRevision: 3,
        }).success).toBe(true);
    });

    it("rejects retired image metadata markers", () => {
        expect(createProductSchema.safeParse({
            ...productInput,
            metaDescription: "SEO<!--variant_images:option1-->",
        }).success).toBe(false);
    });

    it("validates stable product media associations and normalizes empty contextual alt", () => {
        const parsed = createProductSchema.parse({
            ...productInput,
            media: [{
                id: "pmed_primary_1",
                mediaId: "media_primary_1",
                altText: "   ",
                isPrimary: true,
            }],
        });
        expect(parsed.media[0]?.altText).toBeNull();
        expect(createProductSchema.safeParse({
            ...productInput,
            media: Array.from({ length: 250 }, (_, index) => ({
                id: `pmed_item_${index}`,
                mediaId: `media_item_${index}`,
                altText: null,
                isPrimary: index === 0,
            })),
        }).success).toBe(true);

        for (const media of [
            [{ id: "image_1", mediaId: "media_primary_1", altText: null, isPrimary: true }],
            [
                { id: "pmed_primary_1", mediaId: "media_same", altText: null, isPrimary: true },
                { id: "pmed_detail_1", mediaId: "media_same", altText: null, isPrimary: false },
            ],
            [
                { id: "pmed_primary_1", mediaId: "media_primary_1", altText: null, isPrimary: true },
                { id: "pmed_detail_1", mediaId: "media_detail_1", altText: null, isPrimary: true },
            ],
            Array.from({ length: 251 }, (_, index) => ({
                id: `pmed_item_${index}`,
                mediaId: `media_item_${index}`,
                altText: null,
                isPrimary: index === 0,
            })),
        ]) {
            expect(createProductSchema.safeParse({ ...productInput, media }).success).toBe(false);
        }
    });

    it("canonicalizes and bounds product attribute assignments", () => {
        const parsed = createProductSchema.parse({
            ...productInput,
            attributes: [{ attributeId: "  attr_material  ", value: "  Cotton  " }],
        });
        expect(parsed.attributes).toEqual([
            { attributeId: "attr_material", value: "Cotton" },
        ]);

        for (const attributes of [
            [{ attributeId: "attr_material", value: "   " }],
            [{ attributeId: "attr_material", value: "x".repeat(101) }],
            [
                { attributeId: "attr_material", value: "Cotton" },
                { attributeId: "ATTR_MATERIAL", value: "Linen" },
            ],
            Array.from({ length: 91 }, (_, index) => ({
                attributeId: `attr_${index}`,
                value: `Value ${index}`,
            })),
        ]) {
            expect(createProductSchema.safeParse({
                ...productInput,
                attributes,
            }).success).toBe(false);
        }
    });

    it("enforces the bounded Cartesian limit for create and update matrices", () => {
        const values = Array.from(
            { length: MAX_PRODUCT_OPTION_COMBINATIONS + 1 },
            (_, index) => ({ id: `value_${index}`, value: `Value ${index}` }),
        );
        const variants = values.map((value, index) => ({
            id: `variant_${index}`,
            selectedOptionValueIds: [value.id],
            imageId: null,
            weight: null,
            sku: "SKU-M",
            price: 100,
            stock: 0,
            trackInventory: true,
            barcode: null,
            barcodeType: null,
            discountType: "percentage" as const,
            discountPercentage: null,
            discountAmount: null,
        }));
        const matrix = {
            options: [{
                id: "option_finish",
                name: "Finish",
                standardMapping: "none" as const,
                values,
            }],
            variants: variants.map((variant, index) => ({ ...variant, sku: `SKU-${index}` })),
        };

        expect(createProductOptionMatrixSchema.safeParse(matrix).success).toBe(false);
        expect(productOptionMatrixSchema.safeParse({
            ...matrix,
            expectedAggregateRevision: 1,
        }).success).toBe(false);
    });
});
