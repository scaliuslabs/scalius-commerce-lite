// src/modules/categories/categories.validation.ts
import { z } from "zod";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import { isCatalogDiscoveryImageSource } from "@scalius/shared/catalog-discovery-media";
import { categoryStatusSchema } from "@scalius/shared/category-publication";

export const CATEGORY_BATCH_LIMIT = 90;

const nullableText = (max: number) =>
    z.string().trim().max(max).nullable().transform((value) => value || null);

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
        id: z.string().trim().min(1).max(180),
        url: z.string().trim().max(2048).refine(isCatalogDiscoveryImageSource, {
            message: "Category image must be a relative path or an absolute HTTP(S) URL.",
        }),
        filename: z.string().trim().min(1).max(255),
        size: z.number().int().min(0).max(100_000_000),
        createdAt: z
            .date()
            .or(z.string())
            .transform((val) => (val instanceof Date ? val : new Date(val)))
            .refine((value) => Number.isFinite(value.getTime()), {
                message: "Category image creation date is invalid.",
            }),
    })
    .nullable();

const categorySchema = z.object({
    name: z.string().trim().min(3).max(100),
    description: nullableText(100_000),
    content: nullableText(100_000).optional(),
    slug: z
        .string()
        .trim()
        .min(3)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    metaTitle: nullableText(70),
    metaDescription: nullableText(200),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    image: imageSchema,
});

function requireCanonicalCategoryHandle(
    value: { slug: string; canonicalPath?: string | null },
    context: z.RefinementCtx,
): void {
    if (value.canonicalPath !== null && value.canonicalPath !== `/categories/${value.slug}`) {
        context.addIssue({
            code: "custom",
            path: ["canonicalPath"],
            message: "Canonical path must use this category's current slug until URL aliases are supported.",
        });
    }
}

const expectedRevisionSchema = z.number().int().min(1);

export const categoryRevisionClaimSchema = z.object({
    id: z.string().trim().min(1).max(180),
    expectedRevision: expectedRevisionSchema,
});

export const createCategorySchema = categorySchema.superRefine(requireCanonicalCategoryHandle);
export const updateCategorySchema = categorySchema.extend({
    expectedRevision: expectedRevisionSchema,
    status: categoryStatusSchema,
}).superRefine(requireCanonicalCategoryHandle);
export const updateCategoryStatusSchema = z.object({
    expectedRevision: expectedRevisionSchema,
    status: categoryStatusSchema,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type UpdateCategoryStatusInput = z.infer<typeof updateCategoryStatusSchema>;
export type CategoryRevisionClaim = z.infer<typeof categoryRevisionClaimSchema>;
