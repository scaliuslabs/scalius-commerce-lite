// src/modules/pages/pages.validation.ts
// Zod schemas for page create/update operations.
// Imported by admin API routes and PageService.

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
    .refine((value) => value === null || isValidResourceCanonicalPath("page", value), {
        message: "Canonical path must be a single page route such as /returns.",
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
            isValidResourceCanonicalPath("page", value),
        {
            message: "Canonical path must be a single page route such as /returns.",
        },
    );

export const pageFeaturedImageSchema = z.object({
    id: z.string().min(1),
    url: z.string().min(1),
    filename: z.string().min(1),
    size: z.number().nonnegative(),
    mimeType: z.string().optional(),
    altText: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    folderId: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.number(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.number(), z.date()]).optional(),
}).passthrough();

const pageFieldSchemas = {
    title: z.string().min(3).max(100),
    slug: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    content: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().default(false),
    excludeFromSitemap: z.boolean().default(false),
    featuredImage: pageFeaturedImageSchema.nullable().optional(),
};

const publishedAtInputSchema = z.date().or(z.string()).nullable();
const createPublishedAtSchema = publishedAtInputSchema.optional().transform((val) =>
    val instanceof Date ? val : val ? new Date(val) : null,
);
const updatePublishedAtSchema = publishedAtInputSchema.transform((val) =>
    val instanceof Date ? val : val ? new Date(val) : null,
).optional();

/** Schema for creating a new page (POST /api/pages) */
export const createPageSchema = z.object({
    ...pageFieldSchemas,
    publishedAt: createPublishedAtSchema,
    isPublished: z.boolean().default(false),
    sortOrder: z.number().default(0),
    hideHeader: z.boolean().default(false),
    hideFooter: z.boolean().default(false),
    hideTitle: z.boolean().default(false),
});

/** Schema for updating an existing page (PUT /api/pages/:id) */
export const updatePageSchema = z.object({
    title: pageFieldSchemas.title.optional(),
    slug: pageFieldSchemas.slug.optional(),
    content: pageFieldSchemas.content.optional(),
    metaTitle: pageFieldSchemas.metaTitle.optional(),
    metaDescription: pageFieldSchemas.metaDescription.optional(),
    canonicalPath: canonicalPathUpdateSchema,
    noIndex: z.boolean().optional(),
    excludeFromSitemap: z.boolean().optional(),
    isPublished: z.boolean().optional(),
    publishedAt: updatePublishedAtSchema,
    sortOrder: z.number().optional(),
    hideHeader: z.boolean().optional(),
    hideFooter: z.boolean().optional(),
    hideTitle: z.boolean().optional(),
    featuredImage: pageFieldSchemas.featuredImage,
});

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
