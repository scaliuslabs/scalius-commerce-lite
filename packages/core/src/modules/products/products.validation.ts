// src/modules/products/products.validation.ts
// Zod schemas for product create/update operations.
// Imported by both admin API routes and service methods.

import { z } from "zod";

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
    price: z.number().min(0).max(1000000000000),
    categoryId: z.string().min(1),
    isActive: z.boolean(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullish(),
    discountAmount: z.number().min(0).nullish(),
    freeDelivery: z.boolean(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
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
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
