// src/modules/products/products.validation.ts
// Zod schemas for product create/update operations.
// Imported by both admin API routes and service methods.

import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import {
    DEFAULT_PRODUCT_OPTION_LABELS,
    DEFAULT_PRODUCT_OPTION_SCHEMA,
    PRODUCT_OPTION_SCHEMA_VALUES,
} from "@scalius/shared/product-options";
import {
    PRODUCT_CONDITION_VALUES,
} from "@scalius/shared/product-condition";
import { MAX_PRODUCT_PRICE } from "./products.types";

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("product", value), {
        message: "Canonical path must be a product route such as /products/main-shoe.",
    });

const productOptionLabelSchema = z.string().trim().min(1).max(40);
const productOptionSchemaSchema = z.enum(PRODUCT_OPTION_SCHEMA_VALUES);
const productConditionSchema = z.enum(PRODUCT_CONDITION_VALUES);
const variantImageAxisSchema = z.enum(["option1", "option2"]);

const variantImageMappingSchema = z.object({
    imageId: z.string().trim().min(1),
    variantId: z.string().trim().min(1).nullable().optional(),
    optionAxis: variantImageAxisSchema.nullable().optional(),
    optionValue: z.string().trim().min(1).max(100).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
}).superRefine((mapping, ctx) => {
    const hasVariant = Boolean(mapping.variantId);
    const hasOption = Boolean(mapping.optionAxis && mapping.optionValue);
    if (hasVariant === hasOption) {
        ctx.addIssue({
            code: "custom",
            message: "Map each image to either one SKU or one option value",
            path: [],
        });
    }
});

/** Shared image schema used in create and update */
const productImageSchema = z.object({
    id: z.string(),
    url: z.string(),
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
    metaDescription: z.string().nullable(),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    excludeFromProductFeed: z.boolean().optional().default(false),
    productCondition: productConditionSchema,
    variantOption1Label: productOptionLabelSchema
        .optional()
        .default(DEFAULT_PRODUCT_OPTION_LABELS.option1),
    variantOption2Label: productOptionLabelSchema
        .optional()
        .default(DEFAULT_PRODUCT_OPTION_LABELS.option2),
    variantOption1Schema: productOptionSchemaSchema
        .optional()
        .default(DEFAULT_PRODUCT_OPTION_SCHEMA.option1),
    variantOption2Schema: productOptionSchemaSchema
        .optional()
        .default(DEFAULT_PRODUCT_OPTION_SCHEMA.option2),
    variantImagesEnabled: z.boolean().optional(),
    variantImageAxis: variantImageAxisSchema.optional(),
    variantImageMappings: z.array(variantImageMappingSchema).max(250).optional(),
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    images: z.array(productImageSchema),
    attributes: productAttributeSchema,
    additionalInfo: productAdditionalInfoSchema,
});

/** Schema for creating a new product (POST /api/products) */
export const createProductSchema = productBaseSchema;

/** Schema for updating an existing product (PUT /api/products/[id]) */
export const updateProductSchema = productBaseSchema.extend({
    id: z.string(),
    expectedAggregateRevision: z.number().int().min(1),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
