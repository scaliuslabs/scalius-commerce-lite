// src/modules/pages/pages.service.ts
// All DB queries and business logic for the CMS pages domain.

import { pages } from "@scalius/database/schema";
import {
  sql,
  asc,
  desc,
  isNull,
  isNotNull,
  and,
  or,
  lte,
  gt,
  eq,
  ne,
  type SQL,
} from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@scalius/core/errors";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { unixToDate } from "@scalius/shared/timestamps";
import {
  createPageSchema,
  updatePageSchema,
  contentEntryPath,
  isValidContentEntryPath,
  PAGE_BATCH_LIMIT,
  type ContentEntryType,
  type CreatePageInput,
  type PageRevisionClaim,
  type UpdatePageInput,
} from "./pages.validation";
import {
  buildPageRevisionGuard,
  normalizePageRevisionClaims,
  pageClaimIdsCondition,
  rethrowPageRevisionConflict,
} from "./pages.revision";

export {
  createPageSchema,
  updatePageSchema,
  type CreatePageInput,
  type UpdatePageInput,
};

export interface PageLifecycleAuthority {
  canPublish?: boolean;
}

export type AdminPageStatus = "draft" | "scheduled" | "published";

export function adminPageStatusCondition(
  status?: AdminPageStatus,
): SQL | undefined {
  if (status === "draft") return eq(pages.isPublished, false);
  if (status === "scheduled") {
    return and(
      eq(pages.isPublished, true),
      gt(pages.publishedAt, sql`unixepoch()`),
    ) as SQL;
  }
  if (status === "published") {
    return and(
      eq(pages.isPublished, true),
      or(isNull(pages.publishedAt), lte(pages.publishedAt, sql`unixepoch()`)),
    ) as SQL;
  }
  return undefined;
}

function assertPageLifecycleAuthority(
  requestedPublished: boolean,
  currentPublished: boolean,
  authority: PageLifecycleAuthority,
) {
  if (
    requestedPublished !== currentPublished &&
    authority.canPublish !== true
  ) {
    throw new ForbiddenError(
      "Publishing or unpublishing pages requires pages.publish permission.",
    );
  }
}

function pagePublicationTimestamp(
  value: Date | string | number | null | undefined,
) {
  return unixToDate(value)?.getTime() ?? null;
}

function assertPageScheduleAuthority(
  requestedPublishedAt: Date | string | null | undefined,
  currentPublishedAt: Date | string | number | null | undefined,
  authority: PageLifecycleAuthority,
) {
  if (
    pagePublicationTimestamp(requestedPublishedAt) !==
      pagePublicationTimestamp(currentPublishedAt) &&
    authority.canPublish !== true
  ) {
    throw new ForbiddenError(
      "Scheduling page publication requires pages.publish permission.",
    );
  }
}

export function publicPageVisibilityCondition(
  contentType?: ContentEntryType,
): SQL {
  return and(
    isNull(pages.deletedAt),
    contentType ? eq(pages.contentType, contentType) : undefined,
    eq(pages.isPublished, true),
    or(isNull(pages.publishedAt), lte(pages.publishedAt, sql`unixepoch()`)),
  ) as SQL;
}

function isPageSlugConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pages(?:_slug_idx|\.slug)|UNIQUE constraint failed: pages\.slug/i.test(
    message,
  );
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
    status?: AdminPageStatus;
    contentType?: ContentEntryType;
    sort?: "title" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
  } = {},
) {
  const {
    page = 1,
    limit = 10,
    search = "",
    showTrashed = false,
    status,
    contentType = "page",
    sort = "updatedAt",
    order = "desc",
  } = options;

  const conditions: (SQL | undefined)[] = [];
  conditions.push(eq(pages.contentType, contentType));
  if (search) {
    const cond = ftsMatch(db, "pages_fts", "pages", search);
    if (cond) conditions.push(cond);
  }
  if (showTrashed) {
    conditions.push(isNotNull(pages.deletedAt));
  } else {
    conditions.push(isNull(pages.deletedAt));
    conditions.push(adminPageStatusCondition(status));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * limit;

  const total =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(pages)
        .where(whereClause)
        .get()
    )?.count || 0;

  const sortField = (() => {
    switch (sort) {
      case "title":
        return pages.title;
      case "createdAt":
        return pages.createdAt;
      default:
        return pages.updatedAt;
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

export async function getPageById(
  db: Database,
  id: string,
  contentType?: ContentEntryType,
) {
  return (
    db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.id, id),
          contentType ? eq(pages.contentType, contentType) : undefined,
          isNull(pages.deletedAt),
        ),
      )
      .get() ?? null
  );
}

export async function getPageBySlug(
  db: Database,
  slug: string,
  contentType: ContentEntryType = "page",
) {
  return (
    db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.slug, slug),
          eq(pages.contentType, contentType),
          isNull(pages.deletedAt),
        ),
      )
      .get() ?? null
  );
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
  const page =
    (await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), publicPageVisibilityCondition("page")))
      .get()) ?? null;

  return sanitizePageContent(page);
}

export async function getPublicPageBySlug(db: Database, slug: string) {
  const page =
    (await db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, slug), publicPageVisibilityCondition("page")))
      .get()) ?? null;

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

  const whereClause = publicPageVisibilityCondition("page");

  const total =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(pages)
        .where(whereClause)
        .get()
    )?.count || 0;

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

export async function getPublicArticleBySlug(db: Database, slug: string) {
  const article =
    (await db
      .select()
      .from(pages)
      .where(
        and(eq(pages.slug, slug), publicPageVisibilityCondition("article")),
      )
      .get()) ?? null;

  return sanitizePageContent(article);
}

export async function getPublicArticles(
  db: Database,
  options: {
    page?: number;
    limit?: number;
    tag?: string;
  } = {},
) {
  const { page = 1, limit = 12, tag } = options;
  const normalizedTag = tag?.trim().toLocaleLowerCase("en-US") || null;
  const tagCondition = normalizedTag
    ? sql`EXISTS (
            SELECT 1
            FROM json_each(${pages.tags}) AS article_tag
            WHERE lower(trim(CAST(article_tag.value AS TEXT))) = ${normalizedTag}
        )`
    : undefined;
  const whereClause = and(
    publicPageVisibilityCondition("article"),
    tagCondition,
  );
  const total =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(pages)
        .where(whereClause)
        .get()
    )?.count || 0;
  const results = await db
    .select()
    .from(pages)
    .where(whereClause)
    .orderBy(desc(pages.publishedAt), desc(pages.createdAt), desc(pages.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return {
    articles: results.map(sanitizePageRecord),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createPage(
  db: Database,
  data: CreatePageInput,
  authority: PageLifecycleAuthority = {},
): Promise<{ id: string; revision: number }> {
  assertPageLifecycleAuthority(data.isPublished, false, authority);
  assertPageScheduleAuthority(data.publishedAt, null, authority);
  const existing = await db
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.slug, data.slug))
    .get();

  if (existing) {
    throw new ConflictError(
      "A page with this slug already exists, including in trash.",
    );
  }

  const publishedAt = data.isPublished
    ? (data.publishedAt ?? new Date())
    : null;

  const pageId = `${data.contentType === "article" ? "article" : "page"}_${nanoid()}`;
  try {
    await db.insert(pages).values({
      id: pageId,
      contentType: data.contentType,
      title: data.title,
      content: sanitizeHtml(data.content),
      excerpt: data.contentType === "article" ? data.excerpt || null : null,
      author: data.contentType === "article" ? data.author || null : null,
      tags: data.contentType === "article" ? data.tags : [],
      slug: data.slug,
      metaTitle: data.metaTitle || null,
      metaDescription: data.metaDescription || null,
      canonicalPath: data.canonicalPath ?? null,
      noIndex: data.noIndex ?? false,
      excludeFromSitemap: data.excludeFromSitemap ?? false,
      isPublished: data.isPublished,
      publishedAt,
      sortOrder: 0,
      hideHeader: data.hideHeader,
      hideFooter: data.hideFooter,
      hideTitle: data.hideTitle,
      featuredImage: data.featuredImage ?? null,
      revision: 1,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
      deletedAt: null,
    });
  } catch (error) {
    if (isPageSlugConstraintError(error)) {
      throw new ConflictError(
        "A page with this slug already exists, including in trash.",
      );
    }
    throw error;
  }

  return { id: pageId, revision: 1 };
}

export async function updatePage(
  db: Database,
  id: string,
  data: UpdatePageInput,
  authority: PageLifecycleAuthority = {},
): Promise<{ revision: number }> {
  const existing =
    (await db.select().from(pages).where(eq(pages.id, id)).get()) ?? null;
  if (!existing) throw new NotFoundError("Page not found");
  if (existing.deletedAt) {
    throw new ConflictError("Restore this page before editing it.");
  }

  const claims = [{ id, expectedRevision: data.expectedRevision }];
  if (existing.revision !== data.expectedRevision) {
    await rethrowPageRevisionConflict(
      db,
      claims,
      new Error("PAGE_REVISION_CONFLICT"),
      "active",
    );
  }

  if (data.isPublished !== undefined) {
    assertPageLifecycleAuthority(
      data.isPublished,
      existing.isPublished,
      authority,
    );
  }
  if (data.publishedAt !== undefined) {
    assertPageScheduleAuthority(
      data.publishedAt,
      existing.publishedAt,
      authority,
    );
  }

  if (data.slug && data.slug !== existing.slug) {
    const slugConflict = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.slug, data.slug), ne(pages.id, id)))
      .get();
    if (slugConflict) {
      throw new ConflictError(
        "A page with this slug already exists, including in trash.",
      );
    }
  }

  const nextSlug = data.slug ?? existing.slug;
  if (
    !isValidContentEntryPath(
      existing.contentType,
      contentEntryPath(existing.contentType, nextSlug),
    )
  ) {
    throw new ValidationError(
      existing.contentType === "article"
        ? "Choose a valid article URL."
        : "This slug is reserved by the storefront. Choose another page URL.",
    );
  }
  if (
    data.canonicalPath !== undefined &&
    data.canonicalPath !== null &&
    !isValidContentEntryPath(existing.contentType, data.canonicalPath)
  ) {
    throw new ValidationError(
      existing.contentType === "article"
        ? "Canonical path must be an article route such as /blog/running-shoe-guide."
        : "Canonical path must be a single page route such as /returns.",
    );
  }
  if (
    existing.contentType === "page" &&
    (data.excerpt !== undefined ||
      data.author !== undefined ||
      data.tags !== undefined)
  ) {
    throw new ValidationError("Static pages cannot contain article metadata.");
  }

  const { expectedRevision: _, ...updateData } = data;
  if (updateData.content !== undefined) {
    updateData.content = sanitizeHtml(updateData.content);
  }
  if (updateData.excerpt !== undefined) updateData.excerpt ||= null;
  if (updateData.author !== undefined) updateData.author ||= null;

  const nextPublished = data.isPublished ?? existing.isPublished;
  const nextPublishedAt = nextPublished
    ? data.publishedAt !== undefined
      ? (data.publishedAt ?? new Date())
      : existing.isPublished
        ? existing.publishedAt
        : new Date()
    : null;

  let updated: { revision: number } | undefined;
  try {
    updated = await db
      .update(pages)
      .set({
        ...updateData,
        publishedAt: nextPublishedAt,
        revision: sql`${pages.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(
        and(
          eq(pages.id, id),
          eq(pages.revision, data.expectedRevision),
          isNull(pages.deletedAt),
        ),
      )
      .returning({ revision: pages.revision })
      .get();
  } catch (error) {
    if (isPageSlugConstraintError(error)) {
      throw new ConflictError(
        "A page with this slug already exists, including in trash.",
      );
    }
    throw error;
  }
  if (!updated) {
    await rethrowPageRevisionConflict(
      db,
      claims,
      new Error("PAGE_REVISION_CONFLICT"),
      "active",
    );
  }
  return { revision: updated.revision };
}

export async function deletePage(
  db: Database,
  id: string,
  expectedRevision: number,
): Promise<void> {
  await bulkDeletePages(db, [{ id, expectedRevision }], false);
}

async function runPageLifecycleBatch(
  db: Database,
  claims: readonly PageRevisionClaim[],
  requiredState: "active" | "trashed",
  statement: Parameters<typeof safeBatch>[1][number],
): Promise<void> {
  try {
    await safeBatch(db, [
      buildPageRevisionGuard(db, claims, requiredState),
      statement,
    ] as never);
  } catch (error) {
    await rethrowPageRevisionConflict(db, claims, error, requiredState);
  }
}

export async function bulkDeletePages(
  db: Database,
  revisionClaims: PageRevisionClaim[],
  permanent = false,
): Promise<void> {
  const claims = normalizePageRevisionClaims(revisionClaims, PAGE_BATCH_LIMIT);
  if (permanent) {
    await runPageLifecycleBatch(
      db,
      claims,
      "trashed",
      db
        .delete(pages)
        .where(and(pageClaimIdsCondition(claims), isNotNull(pages.deletedAt))),
    );
    return;
  }

  await runPageLifecycleBatch(
    db,
    claims,
    "active",
    db
      .update(pages)
      .set({
        isPublished: false,
        publishedAt: null,
        revision: sql`${pages.revision} + 1`,
        deletedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(pageClaimIdsCondition(claims), isNull(pages.deletedAt))),
  );
}

export async function bulkPublishPages(
  db: Database,
  revisionClaims: PageRevisionClaim[],
): Promise<void> {
  const claims = normalizePageRevisionClaims(revisionClaims, PAGE_BATCH_LIMIT);
  await runPageLifecycleBatch(
    db,
    claims,
    "active",
    db
      .update(pages)
      .set({
        isPublished: true,
        publishedAt: sql`unixepoch()`,
        revision: sql`${pages.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(pageClaimIdsCondition(claims), isNull(pages.deletedAt))),
  );
}

export async function bulkUnpublishPages(
  db: Database,
  revisionClaims: PageRevisionClaim[],
): Promise<void> {
  const claims = normalizePageRevisionClaims(revisionClaims, PAGE_BATCH_LIMIT);
  await runPageLifecycleBatch(
    db,
    claims,
    "active",
    db
      .update(pages)
      .set({
        isPublished: false,
        publishedAt: null,
        revision: sql`${pages.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(pageClaimIdsCondition(claims), isNull(pages.deletedAt))),
  );
}

export async function restorePages(
  db: Database,
  revisionClaims: PageRevisionClaim[],
): Promise<void> {
  const claims = normalizePageRevisionClaims(revisionClaims, PAGE_BATCH_LIMIT);
  await runPageLifecycleBatch(
    db,
    claims,
    "trashed",
    db
      .update(pages)
      .set({
        isPublished: false,
        publishedAt: null,
        revision: sql`${pages.revision} + 1`,
        deletedAt: null,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(pageClaimIdsCondition(claims), isNotNull(pages.deletedAt))),
  );
}

function sanitizePageContent<T extends { content: string }>(
  page: T | null,
): T | null {
  return page ? sanitizePageRecord(page) : null;
}

function sanitizePageRecord<T extends { content: string }>(page: T): T {
  return {
    ...page,
    content: sanitizeHtml(page.content),
  };
}
