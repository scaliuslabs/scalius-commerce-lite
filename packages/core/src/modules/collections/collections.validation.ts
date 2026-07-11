// src/modules/collections/collections.validation.ts
import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import { COLLECTION_CONFIG_ID_LIMIT } from "./collection-config";

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

const collectionConfigSchema = z.object({
    categoryIds: z.array(z.string()).max(COLLECTION_CONFIG_ID_LIMIT).optional().default([]),
    productIds: z.array(z.string()).max(COLLECTION_CONFIG_ID_LIMIT).optional().default([]),
    featuredProductId: z.string().optional(),
    maxProducts: z.number().int().min(1).max(24).optional().default(8),
    title: z.string().optional(),
    subtitle: z.string().optional(),
});

export const createCollectionSchema = z.object({
    name: z.string().min(3).max(100),
    type: z.enum(["manual", "dynamic"]),
    isActive: z.boolean(),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    config: collectionConfigSchema,
});

export const updateCollectionSchema = z.object({
    name: z.string().min(3).max(100).optional(),
    type: z.enum(["manual", "dynamic"]).optional(),
    isActive: z.boolean().optional(),
    canonicalPath: canonicalPathUpdateSchema,
    noIndex: z.boolean().optional(),
    excludeFromSitemap: z.boolean().optional(),
    config: collectionConfigSchema.optional(),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
