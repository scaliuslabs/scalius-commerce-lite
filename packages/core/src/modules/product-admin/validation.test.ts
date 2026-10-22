import { describe, expect, it } from "vitest";
import { createProductSchema, updateProductSchema } from "./validation";
import {
    createVariantSchema,
    updateVariantSchema,
} from "../products/types";
import {
    createProductOptionMatrixSchema,
    productOptionMatrixSchema,
} from "./option-matrix";
import {
    MAX_PRODUCT_OPTION_COMBINATIONS,
} from "../products/option-model";
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

    it("preserves nullable legacy catalog facts on update but requires them on create", () => {
        const nullableFacts = {
            ...productInput,
            categoryId: null,
            productCondition: null,
        };
        expect(createProductSchema.safeParse(nullableFacts).success).toBe(false);
        expect(updateProductSchema.safeParse({
            ...nullableFacts,
            id: "prod_legacy",
            expectedAggregateRevision: 4,
        }).success).toBe(true);
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

    it("a new product's media takes files by mediaId alone: the attachment id is made and the first is featured", () => {
        const parsed = createProductSchema.parse({
            ...productInput,
            media: [{ mediaId: "media_front_1" }, { mediaId: "media_back_1", altText: "Back" }],
        });
        expect(parsed.media).toEqual([
            { id: expect.stringMatching(/^pmed_[A-Za-z0-9_-]+$/u), mediaId: "media_front_1", altText: null, isPrimary: true },
            { id: expect.stringMatching(/^pmed_[A-Za-z0-9_-]+$/u), mediaId: "media_back_1", altText: "Back", isPrimary: false },
        ]);
        expect(parsed.media[0]!.id).not.toBe(parsed.media[1]!.id);
        const { media: _none, ...withoutMedia } = productInput;
        expect(createProductSchema.parse(withoutMedia).media).toEqual([]);

        // A caller's own id (for a SKU's imageId) and featured choice are kept.
        const chosen = createProductSchema.parse({
            ...productInput,
            media: [{ mediaId: "media_front_1" }, { id: "pmed_back_1", mediaId: "media_back_1", isPrimary: true }],
        });
        expect(chosen.media.map((item) => [item.id.startsWith("pmed_"), item.isPrimary])).toEqual([[true, false], [true, true]]);
        expect(chosen.media[1]!.id).toBe("pmed_back_1");

        // Every item saying "not featured" still has no featured image.
        expect(createProductSchema.safeParse({
            ...productInput,
            media: [{ mediaId: "media_front_1", isPrimary: false }],
        }).success).toBe(false);

        // A media file id where the attachment id goes says what is expected.
        const wrong = createProductSchema.safeParse({ ...productInput, media: [{ id: "media_front_1", mediaId: "media_front_1" }] });
        expect(wrong.success).toBe(false);
        expect(wrong.error?.issues[0]).toMatchObject({ path: ["media", 0, "id"], message: expect.stringContaining("pmed_") });
    });

    it("an edit's media still names every attachment by id", () => {
        const media = [{ mediaId: "media_front_1", altText: null, isPrimary: true }];
        expect(updateProductSchema.safeParse({ ...productInput, media }).success).toBe(false);
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

    it("accepts digital kinds, the gift-card flag and a warranty policy id (Wave B)", () => {
        expect(createProductSchema.safeParse({ ...productInput, fulfillmentKind: "digital" }).success).toBe(true);
        expect(createVariantSchema.shape.fulfillmentKind.safeParse("digital").success).toBe(true);
        expect(createProductSchema.safeParse({ ...productInput, warrantyPolicyId: "wrp_policy_0001" }).success).toBe(true);
        expect(createProductSchema.safeParse({ ...productInput, warrantyPolicyId: "brd_nope" }).success).toBe(false);
        expect(updateProductSchema.parse({ ...productInput, id: "prod_1", expectedAggregateRevision: 1 }))
            .not.toHaveProperty("warrantyPolicyId");
        expect(updateProductSchema.parse({ ...productInput, id: "prod_1", expectedAggregateRevision: 1, warrantyPolicyId: null }))
            .toMatchObject({ warrantyPolicyId: null });
    });

    it("refuses gift-card input that is discounted, tracked, stocked or not digital", () => {
        const giftCard = { ...productInput, isGiftCard: true };
        expect(createProductSchema.safeParse(giftCard).success).toBe(true);
        expect(createProductSchema.safeParse({
            ...giftCard,
            defaultSku: { trackInventory: false, stock: 0, fulfillmentKind: "digital" },
        }).success).toBe(true);

        const issues = (input: unknown) => {
            const parsed = createProductSchema.safeParse(input);
            return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        };
        expect(issues({ ...giftCard, discountPercentage: 10 })).toEqual([
            "discountPercentage: Gift cards can't be discounted. Set the discount to 0.",
        ]);
        expect(issues({ ...giftCard, fulfillmentKind: "physical" })).toEqual(["fulfillmentKind: Gift cards are delivered digitally."]);
        expect(issues({ ...giftCard, defaultSku: { trackInventory: true, stock: 5 } })).toEqual([
            "defaultSku.trackInventory: Gift cards don't track quantity. Turn off quantity tracking.",
        ]);
        expect(issues({
            ...giftCard,
            optionMatrix: {
                options: [{ id: "opt", name: "Value", standardMapping: "none", values: [{ id: "v500", value: "500" }] }],
                variants: [{
                    id: "var", selectedOptionValueIds: ["v500"], imageId: null, weight: null, sku: "GC-500", price: 500,
                    stock: 0, trackInventory: false, barcode: null, barcodeType: null,
                    discountType: "flat", discountPercentage: null, discountAmount: 50, fulfillmentKind: "service",
                }],
            },
        })).toEqual([
            "optionMatrix.variants.0.fulfillmentKind: Gift cards are delivered digitally.",
            "optionMatrix.variants.0.discountPercentage: Gift cards can't be discounted. Set the discount to 0.",
        ]);
        expect(updateProductSchema.safeParse({
            ...giftCard, id: "prod_1", expectedAggregateRevision: 1, discountType: "flat", discountAmount: 100,
        }).success).toBe(false);
    });
});
