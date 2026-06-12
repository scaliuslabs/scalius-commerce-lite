// src/modules/pages/pages.service.ts
// All DB queries and business logic for the CMS pages domain.

import { pages } from "@scalius/database/schema";
import { sql, asc, desc, isNull, isNotNull, and, or, lte, inArray, eq, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError } from "@scalius/core/errors";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import {
    createPageSchema,
    updatePageSchema,
    type CreatePageInput,
    type UpdatePageInput,
} from "./pages.validation";

export { createPageSchema, updatePageSchema, type CreatePageInput, type UpdatePageInput };

export function publicPageVisibilityCondition(): SQL {
    return and(
        isNull(pages.deletedAt),
        eq(pages.isPublished, true),
        or(isNull(pages.publishedAt), lte(pages.publishedAt, sql`unixepoch()`)),
    ) as SQL;
}

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
    return db.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).get() ?? null;
}

export async function getPageBySlug(db: Database, slug: string) {
    return db
        .select()
        .from(pages)
        .where(and(eq(pages.slug, slug), isNull(pages.deletedAt)))
        .get() ?? null;
}

// ─────────────────────────────────────────
// Public Queries
// ─────────────────────────────────────────

/** WIRE: api-app should call this from routes/pages.ts (getPageByIdRoute handler)
 *  replacing the inline 14-column SELECT at lines 140-167.
 *  Swap: `const page = await getPublicPageById(db, id);`
 *  then `if (!page) throw new NotFoundError("Page not found");` + `return ok(c, { page });`
 *  This also eliminates unused imports: pages, isNull, eq, and, SQL from drizzle-orm. */
export async function getPublicPageById(db: Database, id: string) {
    const page = await db
        .select()
        .from(pages)
        .where(and(eq(pages.id, id), publicPageVisibilityCondition()))
        .get() ?? null;

    return sanitizePageContent(page);
}

export async function getPublicPageBySlug(db: Database, slug: string) {
    const page = await db
        .select()
        .from(pages)
        .where(and(eq(pages.slug, slug), publicPageVisibilityCondition()))
        .get() ?? null;

    return sanitizePageContent(page);
}

export async function getPublicPages(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        sort?: "title" | "createdAt" | "-title" | "-createdAt";
    } = {},
) {
    const { page = 1, limit = 10, sort = "title" } = options;

    const whereClause = publicPageVisibilityCondition();

    const total = (await db
        .select({ count: sql<number>`count(*)` })
        .from(pages)
        .where(whereClause)
        .get())?.count || 0;

    const sortField = sort.startsWith("-") ? sort.substring(1) : sort;
    const sortDirection = sort.startsWith("-") ? "desc" : "asc";
    const orderCol = sortField === "title" ? pages.title : pages.createdAt;
    const orderBy = sortDirection === "asc" ? asc(orderCol) : desc(orderCol);

    const offset = (page - 1) * limit;
    const results = await db
        .select()
        .from(pages)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

    return {
        pages: results.map(sanitizePageRecord),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
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
        content: sanitizeHtml(data.content),
        slug: data.slug,
        metaTitle: data.metaTitle || null,
        metaDescription: data.metaDescription || null,
        isPublished: data.isPublished,
        publishedAt: data.publishedAt ?? null,
        sortOrder: data.sortOrder ?? 0,
        hideHeader: data.hideHeader,
        hideFooter: data.hideFooter,
        hideTitle: data.hideTitle,
        featuredImage: data.featuredImage ?? null,
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

    const updateData = { ...data };
    if (updateData.content !== undefined) {
        updateData.content = sanitizeHtml(updateData.content);
    }

    await db.update(pages).set({ ...updateData, updatedAt: sql`unixepoch()` }).where(eq(pages.id, id));
}

export async function deletePage(db: Database, id: string): Promise<void> {
    await db.update(pages).set({ deletedAt: sql`unixepoch()` }).where(eq(pages.id, id));
}

export async function bulkDeletePages(db: Database, ids: string[], permanent = false): Promise<void> {
    if (ids.length === 0) return;
    if (permanent) {
        await db.delete(pages).where(inArray(pages.id, ids));
    } else {
        await db.update(pages).set({ deletedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
    }
}

export async function bulkPublishPages(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(pages).set({ isPublished: true, updatedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
}

export async function bulkUnpublishPages(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(pages).set({ isPublished: false, updatedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
}

export async function restorePages(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(pages).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(inArray(pages.id, ids));
}

function sanitizePageContent<T extends { content: string }>(page: T | null): T | null {
    return page ? sanitizePageRecord(page) : null;
}

function sanitizePageRecord<T extends { content: string }>(page: T): T {
    return {
        ...page,
        content: sanitizeHtml(page.content),
    };
}
