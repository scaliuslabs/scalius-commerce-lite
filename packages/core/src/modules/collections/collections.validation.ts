// src/modules/collections/collections.validation.ts
import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import { COLLECTION_CONFIG_ID_LIMIT } from "./collection-config";

const nullableText = (max: number) =>
    z.string().trim().max(max).nullable().transform((value) => value || null).optional();

const optionalNullableText = (max: number) =>
    z.string().trim().max(max).nullable().transform((value) => value || null).optional();

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("collection", value), {
        message: "Canonical path must be a collection route such as /collections/col_1.",
    });
const canonicalPathUpdateSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => value === undefined ? undefined : normalizeCanonicalPathInput(value))
    .refine(
        (value) =>
            value === undefined ||
            value === null ||
            isValidResourceCanonicalPath("collection", value),
        {
            message:
                "Canonical path must be a collection route such as /collections/col_1.",
        },
    );

const productIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine((id) => id.startsWith("prod_"), {
        message: "Product references must use product IDs.",
    });

const collectionConfigSchema = z.object({
    source: z.enum(["manual", "dynamic"]),
    categoryIds: z.array(z.string().trim().min(1).max(180)).max(COLLECTION_CONFIG_ID_LIMIT).optional().default([]),
    productIds: z.array(productIdSchema).max(COLLECTION_CONFIG_ID_LIMIT).optional().default([]),
    featuredProductId: z.string().trim().max(180).optional(),
    showOnHomepage: z.boolean().optional().default(false),
    maxProducts: z.number().int().min(1).max(24).optional().default(8),
    title: z.string().trim().max(120).optional(),
    subtitle: z.string().trim().max(240).optional(),
});
const collectionConfigUpdateSchema = z.object({
    source: z.enum(["manual", "dynamic"]).optional(),
    categoryIds: z.array(z.string().trim().min(1).max(180)).max(COLLECTION_CONFIG_ID_LIMIT).optional(),
    productIds: z.array(productIdSchema).max(COLLECTION_CONFIG_ID_LIMIT).optional(),
    featuredProductId: z.string().trim().max(180).optional(),
    showOnHomepage: z.boolean().optional(),
    maxProducts: z.number().int().min(1).max(24).optional(),
    title: z.string().trim().max(120).optional(),
    subtitle: z.string().trim().max(240).optional(),
});

function validatePublishReadiness(
    value: { isActive?: boolean; config?: z.infer<typeof collectionConfigSchema> },
    ctx: z.RefinementCtx,
) {
    if (!value.isActive || !value.config) return;
    if (value.config.source === "manual" && value.config.productIds.length === 0) {
        ctx.addIssue({
            code: "custom",
            path: ["config", "productIds"],
            message: "Add at least one product before publishing a manual collection.",
        });
    }
    if (value.config.source === "dynamic" && value.config.categoryIds.length === 0) {
        ctx.addIssue({
            code: "custom",
            path: ["config", "categoryIds"],
            message: "Select at least one category before publishing a dynamic collection.",
        });
    }
}

export const createCollectionSchema = z.object({
    name: z.string().min(3).max(100),
    description: nullableText(100_000),
    content: nullableText(100_000),
    presentation: z.enum(["grid", "carousel"]),
    isActive: z.boolean(),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    metaTitle: nullableText(70),
    metaDescription: nullableText(200),
    config: collectionConfigSchema,
}).superRefine(validatePublishReadiness);

export const updateCollectionSchema = z.object({
    expectedVersion: z.number().int().min(1),
    name: z.string().min(3).max(100).optional(),
    description: optionalNullableText(100_000),
    content: optionalNullableText(100_000),
    presentation: z.enum(["grid", "carousel"]).optional(),
    isActive: z.boolean().optional(),
    canonicalPath: canonicalPathUpdateSchema,
    noIndex: z.boolean().optional(),
    excludeFromSitemap: z.boolean().optional(),
    metaTitle: optionalNullableText(70),
    metaDescription: optionalNullableText(200),
    config: collectionConfigUpdateSchema.optional(),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
