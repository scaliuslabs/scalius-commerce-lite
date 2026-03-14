// src/modules/pages/pages.validation.ts
// Zod schemas for page create/update operations.
// Imported by admin API routes and PageService.

import { z } from "zod";

/** Schema for creating a new page (POST /api/pages) */
export const createPageSchema = z.object({
    title: z.string().min(3).max(100),
    slug: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    content: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    isPublished: z.boolean().default(true),
    publishedAt: z.date().or(z.string()).nullable().optional().transform((val) =>
        val instanceof Date ? val : val ? new Date(val) : null,
    ),
    sortOrder: z.number().default(0),
    hideHeader: z.boolean().default(false),
    hideFooter: z.boolean().default(false),
    hideTitle: z.boolean().default(false),
});

/** Schema for updating an existing page (PUT /api/pages/:id) */
export const updatePageSchema = createPageSchema.partial();

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
