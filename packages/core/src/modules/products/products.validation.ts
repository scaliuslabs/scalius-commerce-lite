// src/modules/products/products.validation.ts
// Zod schemas for product create/update operations.
// Imported by both admin API routes and service methods.

import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import {
    PRODUCT_CONDITION_VALUES,
} from "@scalius/shared/product-condition";
import { catalogMoneySchema, skuStockSchema, skuWeightSchema } from "./products.types";
import { createProductOptionMatrixSchema } from "./products.option-matrix";
import { MAX_PRODUCT_MEDIA_ASSOCIATIONS } from "./products.media";

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("product", value), {
        message: "Canonical path must be a product route such as /products/main-shoe.",
    });

const productConditionSchema = z.enum(PRODUCT_CONDITION_VALUES);

export const productMediaAssociationIdSchema = z.string()
    .trim()
    .min(10)
    .max(80)
    .regex(/^pmed_[A-Za-z0-9_-]+$/u, "Product media association ID is invalid.");

const globalMediaIdSchema = z.string()
    .trim()
    .min(8)
    .max(160)
    .regex(/^[A-Za-z0-9_-]+$/u, "Media ID is invalid.");

/** Ordered product association contract; request order becomes dense sortOrder. */
export const productMediaInputSchema = z.array(z.object({
    id: productMediaAssociationIdSchema,
    mediaId: globalMediaIdSchema,
    altText: z.string().trim().max(500).nullable()
        .transform((value) => value?.trim() ? value.trim() : null),
    isPrimary: z.boolean(),
})).max(
    MAX_PRODUCT_MEDIA_ASSOCIATIONS,
    `Attach at most ${MAX_PRODUCT_MEDIA_ASSOCIATIONS} media items to a product.`,
).superRefine((items, context) => {
    const ids = new Set<string>();
    const mediaIds = new Set<string>();
    let primaryCount = 0;
    items.forEach((item, index) => {
        if (ids.has(item.id)) {
            context.addIssue({ code: "custom", path: [index, "id"], message: "Each product media association ID must be unique." });
        }
        if (mediaIds.has(item.mediaId)) {
            context.addIssue({ code: "custom", path: [index, "mediaId"], message: "The same media asset can be attached only once." });
        }
        ids.add(item.id);
        mediaIds.add(item.mediaId);
        if (item.isPrimary) primaryCount += 1;
    });
    if (items.length > 0 && primaryCount !== 1) {
        context.addIssue({
            code: "custom",
            message: "Choose exactly one featured media item.",
            path: [Math.max(0, items.findIndex((item) => item.isPrimary)), "isPrimary"],
        });
    }
});

/** Shared attribute schema used in create and update */
const productAttributeSchema = z.array(
    z.object({
        attributeId: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(100),
    }),
)
    .max(90, "Assign at most 90 attributes to a product")
    .superRefine((assignments, context) => {
        const seenAttributeIds = new Set<string>();
        assignments.forEach((assignment, index) => {
            const key = assignment.attributeId.toLowerCase();
            if (seenAttributeIds.has(key)) {
                context.addIssue({
                    code: "custom",
                    path: [index, "attributeId"],
                    message: "Each attribute can be assigned only once",
                });
            }
            seenAttributeIds.add(key);
        });
    })
    .optional();

/** Shared additional info schema used in create and update */
const productAdditionalInfoSchema = z.array(
    z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        sortOrder: z.number(),
    }),
).optional();

/** Base product fields shared between create and update */
const productBaseSchema = z.object({
    name: z.string().min(3).max(100),
    description: z.string().min(10).nullable(),
    price: catalogMoneySchema,
    categoryId: z.string().min(1).nullable(),
    isActive: z.boolean(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullish(),
    discountAmount: catalogMoneySchema.nullish(),
    freeDelivery: z.boolean(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable().refine(
        (value) => !value?.includes("<!--variant_images:"),
        "Legacy variant-image metadata is not allowed. Assign images directly to SKUs.",
    ),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    excludeFromProductFeed: z.boolean().optional().default(false),
    productCondition: productConditionSchema.nullable(),
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    media: productMediaInputSchema,
    attributes: productAttributeSchema,
    additionalInfo: productAdditionalInfoSchema,
});

function requireCanonicalProductHandle(
    value: { slug: string; canonicalPath?: string | null },
    context: z.RefinementCtx,
): void {
    if (value.canonicalPath !== null && value.canonicalPath !== `/products/${value.slug}`) {
        context.addIssue({
            code: "custom",
            path: ["canonicalPath"],
            message: "Canonical path must use this product's current slug until URL aliases are supported.",
        });
    }
}

/**
 * A product on sale needs a price customers can pay (feeds and checkout
 * reject non-positive prices), and a fixed discount can't exceed the price.
 */
function requireSellablePrice(
    value: { isActive: boolean; price: number; discountType?: "percentage" | "flat"; discountAmount?: number | null },
    context: z.RefinementCtx,
): void {
    if (value.isActive && value.price <= 0) {
        context.addIssue({ code: "custom", path: ["price"], message: "Enter a price above 0 to make this product active." });
    }
    if (value.discountType === "flat" && (value.discountAmount ?? 0) > value.price) {
        context.addIssue({ code: "custom", path: ["discountAmount"], message: "A discount can't be more than the price." });
    }
}

/** Inventory facts for the hidden SKU of a product created without options. */
const defaultSkuInputSchema = z.object({
    sku: z.string().trim().min(3).max(100).optional()
        .describe("Omit to generate a readable SKU from the product title."),
    trackInventory: z.boolean(),
    stock: skuStockSchema.describe("Initial on-hand quantity; must be 0 when inventory is not tracked."),
    barcode: z.string().trim().max(50).nullable().optional()
        .describe("Scanned or printed barcode. Omit or null to generate an internal Code 128 barcode."),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).nullable().optional(),
    weight: skuWeightSchema.nullable().optional(),
}).refine((value) => value.trackInventory || value.stock === 0, {
    message: "Turn on quantity tracking before setting a quantity.",
    path: ["stock"],
});

/** Schema for creating a new product (POST /api/products) */
export const createProductSchema = productBaseSchema
    .extend({
        categoryId: z.string().min(1),
        productCondition: productConditionSchema,
        optionMatrix: createProductOptionMatrixSchema.optional(),
        defaultSku: defaultSkuInputSchema.optional()
            .describe("Inventory for a product without options. Omit for an untracked SKU. Not allowed with optionMatrix."),
    })
    .superRefine(requireCanonicalProductHandle)
    .superRefine(requireSellablePrice)
    .superRefine((value, context) => {
        if (!value.isActive) return;
        value.optionMatrix?.variants.forEach((variant, index) => {
            if (variant.price <= 0) {
                context.addIssue({
                    code: "custom",
                    path: ["optionMatrix", "variants", index, "price"],
                    message: "Enter a price above 0 for every variant of an active product.",
                });
            }
        });
    })
    .refine((value) => !(value.optionMatrix && value.defaultSku), {
        message: "Send either optionMatrix or defaultSku, not both.",
        path: ["defaultSku"],
    });

/** Schema for updating an existing product (PUT /api/products/[id]) */
export const updateProductSchema = productBaseSchema
    .extend({
        id: z.string(),
        expectedAggregateRevision: z.number().int().min(1),
        acknowledgedSkuImageRemovalIds: z.array(productMediaAssociationIdSchema)
            .max(MAX_PRODUCT_MEDIA_ASSOCIATIONS)
            .refine((ids) => new Set(ids).size === ids.length, {
                message: "Each acknowledged product media association must be unique.",
            })
            .optional(),
    })
    .superRefine(requireCanonicalProductHandle)
    .superRefine(requireSellablePrice);

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
