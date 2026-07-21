// src/modules/pages/pages.validation.ts
// Zod schemas for page create/update operations.
// Imported by admin API routes and PageService.

import { z } from "zod";
import {
  isValidCanonicalPath,
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";

export const PAGE_BATCH_LIMIT = 90;

const expectedRevisionSchema = z.number().int().min(1);
export const contentEntryTypeSchema = z.enum(["page", "article"]);
export type ContentEntryType = z.infer<typeof contentEntryTypeSchema>;

const contentSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export function contentEntryPath(
  contentType: ContentEntryType,
  slug: string,
): string {
  return contentType === "article" ? `/blog/${slug}` : `/${slug}`;
}

export function isValidContentEntryPath(
  contentType: ContentEntryType,
  path: string,
): boolean {
  return isValidResourceCanonicalPath(contentType, path);
}

const canonicalPathSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) => normalizeCanonicalPathInput(value))
  .refine((value) => value === null || isValidCanonicalPath(value), {
    message: "Canonical path must be a safe same-store path.",
  });
const canonicalPathUpdateSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : normalizeCanonicalPathInput(value),
  )
  .refine(
    (value) =>
      value === undefined || value === null || isValidCanonicalPath(value),
    {
      message: "Canonical path must be a safe same-store path.",
    },
  );

const articleTagsSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(20)
  .transform((values) => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = value.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const pageFeaturedImageSchema = z
  .object({
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
  })
  .passthrough();

const pageFieldSchemas = {
  title: z.string().min(3).max(100),
  slug: contentSlugSchema,
  content: z.string(),
  excerpt: z.string().trim().max(500).nullable(),
  author: z.string().trim().max(100).nullable(),
  tags: articleTagsSchema,
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: canonicalPathSchema,
  noIndex: z.boolean().default(false),
  excludeFromSitemap: z.boolean().default(false),
  featuredImage: pageFeaturedImageSchema.nullable().optional(),
};

const publishedAtInputSchema = z.date().or(z.string()).nullable();
const createPublishedAtSchema = publishedAtInputSchema
  .optional()
  .transform((val) => (val instanceof Date ? val : val ? new Date(val) : null))
  .refine((val) => val === null || Number.isFinite(val.getTime()), {
    message: "Publication time must be a valid date.",
  });
const updatePublishedAtSchema = publishedAtInputSchema
  .transform((val) => (val instanceof Date ? val : val ? new Date(val) : null))
  .refine((val) => val === null || Number.isFinite(val.getTime()), {
    message: "Publication time must be a valid date.",
  })
  .optional();

/** Schema for creating a new page (POST /api/pages) */
export const createPageSchema = z
  .object({
    ...pageFieldSchemas,
    contentType: contentEntryTypeSchema.default("page"),
    excerpt: pageFieldSchemas.excerpt.default(null),
    author: pageFieldSchemas.author.default(null),
    tags: pageFieldSchemas.tags.default([]),
    publishedAt: createPublishedAtSchema,
    isPublished: z.boolean().default(false),
    hideHeader: z.boolean().default(false),
    hideFooter: z.boolean().default(false),
    hideTitle: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const publicPath = contentEntryPath(value.contentType, value.slug);
    if (!isValidContentEntryPath(value.contentType, publicPath)) {
      ctx.addIssue({
        code: "custom",
        path: ["slug"],
        message:
          value.contentType === "article"
            ? "Choose a valid article URL."
            : "This slug is reserved by the storefront. Choose another page URL.",
      });
    }
    if (
      value.canonicalPath !== null &&
      !isValidContentEntryPath(value.contentType, value.canonicalPath)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["canonicalPath"],
        message:
          value.contentType === "article"
            ? "Canonical path must be an article route such as /blog/running-shoe-guide."
            : "Canonical path must be a single page route such as /returns.",
      });
    }
    if (
      value.contentType === "page" &&
      (value.excerpt !== null || value.author !== null || value.tags.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["contentType"],
        message: "Static pages cannot contain article metadata.",
      });
    }
  });

/** Schema for updating an existing page (PUT /api/pages/:id) */
export const updatePageSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  title: pageFieldSchemas.title.optional(),
  slug: pageFieldSchemas.slug.optional(),
  content: pageFieldSchemas.content.optional(),
  excerpt: pageFieldSchemas.excerpt.optional(),
  author: pageFieldSchemas.author.optional(),
  tags: pageFieldSchemas.tags.optional(),
  metaTitle: pageFieldSchemas.metaTitle.optional(),
  metaDescription: pageFieldSchemas.metaDescription.optional(),
  canonicalPath: canonicalPathUpdateSchema,
  noIndex: z.boolean().optional(),
  excludeFromSitemap: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  publishedAt: updatePublishedAtSchema,
  hideHeader: z.boolean().optional(),
  hideFooter: z.boolean().optional(),
  hideTitle: z.boolean().optional(),
  featuredImage: pageFieldSchemas.featuredImage,
});

export const pageRevisionClaimSchema = z.object({
  id: z.string().trim().min(1).max(180),
  expectedRevision: expectedRevisionSchema,
});

export const pageRevisionClaimsSchema = z.object({
  pages: z.array(pageRevisionClaimSchema).min(1).max(PAGE_BATCH_LIMIT),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
export type PageRevisionClaim = z.infer<typeof pageRevisionClaimSchema>;
