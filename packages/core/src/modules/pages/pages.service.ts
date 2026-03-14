// src/modules/pages/pages.service.ts
// All DB queries and business logic for the CMS pages domain.

import { pages } from "@scalius/database/schema";
import { sql, asc, desc, isNull, isNotNull, and, inArray, eq, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError } from "@scalius/core/errors";

// ─────────────────────────────────────────
// Schema
// ─────────────────────────────────────────

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

export const updatePageSchema = createPageSchema.partial();

export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listPages(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "title" | "createdAt" | "updatedAt" | "sortOrder";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit = 10,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;

    const conditions: (SQL | undefined)[] = [];
    if (search) {
        const cond = ftsMatch("pages_fts", "pages", search);
        if (cond) conditions.push(cond);
    }
    if (showTrashed) {
        conditions.push(isNotNull(pages.deletedAt));
    } else {
        conditions.push(isNull(pages.deletedAt));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (page - 1) * limit;

    const total = (await db
        .select({ count: sql<number>`count(*)` })
        .from(pages)
        .where(whereClause)
        .get())?.count || 0;

    const sortField = (() => {
        switch (sort) {
            case "title": return pages.title;
            case "createdAt": return pages.createdAt;
            case "sortOrder": return pages.sortOrder;
            default: return pages.updatedAt;
        }
    })();

    const results = await db
        .select()
        .from(pages)
        .where(whereClause)
        .orderBy(order === "asc" ? asc(sortField) : desc(sortField))
        .limit(limit)
        .offset(offset);

    return {
        pages: results,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
}

export async function getPageById(db: Database, id: string) {
    return db.select().from(pages).where(eq(pages.id, id)).get() ?? null;
}

export async function getPageBySlug(db: Database, slug: string) {
    return db
        .select()
        .from(pages)
        .where(and(eq(pages.slug, slug), isNull(pages.deletedAt)))
        .get() ?? null;
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createPage(db: Database, data: CreatePageInput): Promise<{ id: string }> {
    const existing = await db
        .select({ id: pages.id })
        .from(pages)
        .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
        .get();

    if (existing) throw new ConflictError("A page with this slug already exists");

    const pageId = "page_" + nanoid();
    await db.insert(pages).values({
        id: pageId,
        title: data.title,
        content: data.content,
        slug: data.slug,
        metaTitle: data.metaTitle || null,
        metaDescription: data.metaDescription || null,
        isPublished: data.isPublished,
        hideHeader: data.hideHeader,
        hideFooter: data.hideFooter,
        hideTitle: data.hideTitle,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
    });

    return { id: pageId };
}

export async function updatePage(db: Database, id: string, data: UpdatePageInput): Promise<void> {
    const existing = await getPageById(db, id);
    if (!existing) throw new NotFoundError("Page not found");

    if (data.slug && data.slug !== existing.slug) {
        const slugConflict = await db
            .select({ id: pages.id })
            .from(pages)
            .where(sql`slug = ${data.slug} AND deleted_at IS NULL AND id != ${id}`)
            .get();
        if (slugConflict) throw new ConflictError("A page with this slug already exists");
    }

    await db.update(pages).set({ ...data, updatedAt: sql`unixepoch()` }).where(eq(pages.id, id));
}

export async function deletePage(db: Database, id: string): Promise<void> {
    await db.update(pages).set({ deletedAt: sql`unixepoch()` }).where(eq(pages.id, id));
}

export async function bulkDeletePages(db: Database, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        await db.delete(pages).where(inArray(pages.id, ids));
    } else {
        await db.update(pages).set({ deletedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
    }
}

export async function bulkPublishPages(db: Database, ids: string[]): Promise<void> {
    await db.update(pages).set({ isPublished: true, updatedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
}

export async function bulkUnpublishPages(db: Database, ids: string[]): Promise<void> {
    await db.update(pages).set({ isPublished: false, updatedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
}

export async function restorePages(db: Database, ids: string[]): Promise<void> {
    await db.update(pages).set({ deletedAt: null }).where(inArray(pages.id, ids));
}
