// src/modules/categories/categories.validation.ts
import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("category", value), {
        message: "Canonical path must be a category route such as /categories/summer-shoes.",
    });

const imageSchema = z
    .object({
        id: z.string(),
        url: z.string(),
        filename: z.string(),
        size: z.number(),
        createdAt: z
            .date()
            .or(z.string())
            .transform((val) => (val instanceof Date ? val : new Date(val))),
    })
    .nullable();

export const createCategorySchema = z.object({
    name: z.string().min(3).max(100),
    description: z.string().nullable(),
    slug: z
        .string()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    image: imageSchema,
});

export const updateCategorySchema = createCategorySchema;

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
