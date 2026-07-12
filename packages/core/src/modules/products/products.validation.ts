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
import { MAX_PRODUCT_PRICE } from "./products.types";
import { createProductOptionMatrixSchema } from "./products.option-matrix";
import { isCatalogDiscoveryImageSource } from "@scalius/shared/catalog-discovery-media";

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("product", value), {
        message: "Canonical path must be a product route such as /products/main-shoe.",
    });

const productConditionSchema = z.enum(PRODUCT_CONDITION_VALUES);

/** Shared image schema used in create and update */
const productImageSchema = z.object({
    id: z.string(),
    url: z.string().refine(isCatalogDiscoveryImageSource, {
        message: "Product image must be a relative path or an absolute HTTP(S) URL.",
    }),
    filename: z.string(),
    size: z.number(),
    createdAt: z
        .date()
        .or(z.string())
        .transform((val) => (val instanceof Date ? val : new Date(val))),
});

/** Shared attribute schema used in create and update */
const productAttributeSchema = z.array(
    z.object({
        attributeId: z.string(),
        value: z.string(),
    }),
).optional();

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
    price: z.number().min(0).max(MAX_PRODUCT_PRICE),
    categoryId: z.string().min(1),
    isActive: z.boolean(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullish(),
    discountAmount: z.number().min(0).nullish(),
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
    productCondition: productConditionSchema,
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    images: z.array(productImageSchema),
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

/** Schema for creating a new product (POST /api/products) */
export const createProductSchema = productBaseSchema
    .extend({
        optionMatrix: createProductOptionMatrixSchema.optional(),
    })
    .superRefine(requireCanonicalProductHandle);

/** Schema for updating an existing product (PUT /api/products/[id]) */
export const updateProductSchema = productBaseSchema
    .extend({
        id: z.string(),
        expectedAggregateRevision: z.number().int().min(1),
    })
    .superRefine(requireCanonicalProductHandle);

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
