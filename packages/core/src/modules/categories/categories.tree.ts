// The category tree (migration 0090). The application writes only
// `categories.parent_id`; triggers keep `depth`, the id `path` and
// `category_closure` exact and refuse cycles, a fifth level and trashed
// parents. This file holds the placement pre-check (which explains a refusal
// before it is sent; the triggers stay the authority), the revision-guarded
// move, and every tree read. Reads are bounded and index-driven: children by
// `categories_parent_idx`, breadcrumbs and subtrees by the closure keys.

import { categories, categoryClosure } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, desc, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
    CATEGORY_TREE_MAX_DEPTH,
    categoryPlacementProblem,
    type CategoryPlacementProblem,
} from "@scalius/shared/catalog-tree";
import { AppError, ConflictError, NotFoundError } from "@scalius/core/errors";
import type { MoveCategoryInput } from "./categories.validation";
import { assertCategoryClaimsCurrent } from "./categories.revision";
import { publicCategoryConditions } from "./categories.publication";

/** Links the storefront tree read serves at most (the header's link budget). */
export const CATEGORY_TREE_LINK_LIMIT = 150;
/** Children one listing read returns at most (sub-category pills, a drill level). */
export const CATEGORY_CHILDREN_LIMIT = 100;

export type CategoryPlacementRefusal = CategoryPlacementProblem | "parent_unavailable";

const PLACEMENT_MESSAGES: Record<CategoryPlacementRefusal, string> = {
    cycle: "A category cannot be placed under itself or one of its sub-categories.",
    too_deep: `Categories go at most ${CATEGORY_TREE_MAX_DEPTH + 1} levels deep. Choose a higher parent category.`,
    parent_unavailable: "Choose a parent category that exists and is not in trash.",
};

export class CategoryPlacementError extends AppError {
    constructor(public readonly reason: CategoryPlacementRefusal, categoryId: string | null, parentId: string | null) {
        super(400, "CATEGORY_PLACEMENT_REFUSED", PLACEMENT_MESSAGES[reason], { reason, categoryId, parentId });
        this.name = "CategoryPlacementError";
    }
}

/** The trigger refusal an error carries (its message or any cause's), if any. */
export function categoryTreeRefusal(error: unknown): CategoryPlacementRefusal | null {
    for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
        const message = current instanceof Error ? current.message : String(current);
        if (message.includes("category cannot move under itself or its descendants")) return "cycle";
        if (message.includes("category tree is limited to four levels")) return "too_deep";
        if (message.includes("category parent must be another live category")) return "parent_unavailable";
        current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
    }
    return null;
}

/** Rethrows a trigger refusal as the typed placement error; anything else unchanged. */
export function rethrowCategoryTreeRefusal(error: unknown, categoryId: string | null, parentId: string | null): never {
    const reason = categoryTreeRefusal(error);
    if (reason) throw new CategoryPlacementError(reason, categoryId, parentId);
    throw error;
}

/**
 * Why placing `categoryId` (null for a new category) under `parentId` would
 * be refused, or null. One indexed read: the parent row, whether it sits in
 * the category's own subtree, and the subtree's height.
 */
export async function categoryPlacementRefusal(
    db: Database,
    categoryId: string | null,
    parentId: string | null,
): Promise<CategoryPlacementRefusal | null> {
    if (parentId === null) return null;
    if (categoryId !== null && parentId === categoryId) return "cycle";
    const row = await db
        .select({
            depth: categories.depth,
            live: sql<number>`CASE WHEN ${categories.deletedAt} IS NULL THEN 1 ELSE 0 END`,
            inSubtree: categoryId === null
                ? sql<number>`0`
                : sql<number>`EXISTS (
                    SELECT 1 FROM category_closure AS placement
                    WHERE placement.ancestor_id = ${categoryId} AND placement.descendant_id = ${parentId}
                )`,
            subtreeHeight: categoryId === null
                ? sql<number>`0`
                : sql<number>`coalesce((
                    SELECT max(placement.depth) FROM category_closure AS placement
                    WHERE placement.ancestor_id = ${categoryId}
                ), 0)`,
        })
        .from(categories)
        .where(eq(categories.id, parentId))
        .get();
    if (!row || !Number(row.live)) return "parent_unavailable";
    return categoryPlacementProblem({
        parentDepth: Number(row.depth),
        subtreeHeight: Number(row.subtreeHeight ?? 0),
        parentIsInSubtree: Boolean(Number(row.inSubtree)),
    });
}

/** Throws the typed placement error when the pre-check refuses the placement. */
export async function assertCategoryPlacement(
    db: Database,
    categoryId: string | null,
    parentId: string | null,
): Promise<void> {
    const reason = await categoryPlacementRefusal(db, categoryId, parentId);
    if (reason) throw new CategoryPlacementError(reason, categoryId, parentId);
}

/**
 * Moves a category (with its whole subtree) under another parent, or to the
 * top level. Revision-guarded like every category write; a move to the
 * current parent changes nothing and keeps the revision.
 */
export async function moveCategory(
    db: Database,
    id: string,
    data: MoveCategoryInput,
): Promise<{ revision: number; parentId: string | null; changed: boolean }> {
    const existing = await db
        .select({
            revision: categories.revision,
            parentId: categories.parentId,
            deletedAt: categories.deletedAt,
        })
        .from(categories)
        .where(eq(categories.id, id))
        .get();
    if (!existing) throw new NotFoundError("Category not found");
    const claims = [{ id, expectedRevision: data.expectedRevision }];
    if (existing.deletedAt || existing.revision !== data.expectedRevision) {
        await assertCategoryClaimsCurrent(db, claims, "active");
    }
    if (existing.parentId === data.parentId) {
        return { revision: existing.revision, parentId: existing.parentId, changed: false };
    }
    await assertCategoryPlacement(db, id, data.parentId);

    let updated: { revision: number } | undefined;
    try {
        updated = await db
            .update(categories)
            .set({
                parentId: data.parentId,
                revision: sql`${categories.revision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(categories.id, id),
                eq(categories.revision, data.expectedRevision),
                isNull(categories.deletedAt),
            ))
            .returning({ revision: categories.revision })
            .get();
    } catch (error) {
        rethrowCategoryTreeRefusal(error, id, data.parentId);
    }
    if (!updated) {
        await assertCategoryClaimsCurrent(db, claims, "active");
        throw new ConflictError("Category could not be moved. Reload and try again.");
    }
    return { revision: updated.revision, parentId: data.parentId, changed: true };
}

// ─────────────────────────────────────────
// Trash rules (the service's; the database only refuses new children under a
// trashed parent and a hard delete of a parent that still has children)
// ─────────────────────────────────────────

const claimIdSet = (claimsJson: string) => sql`(
    SELECT CAST(json_extract(value, '$.id') AS TEXT) FROM json_each(${claimsJson})
)`;

/** No live child of a claimed category stays outside the claimed set. */
export function categoriesHaveNoLiveChildrenOutsideCondition(claimsJson: string): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM categories AS tree_child
        WHERE tree_child.parent_id IN ${claimIdSet(claimsJson)}
          AND tree_child.deleted_at IS NULL
          AND tree_child.id NOT IN ${claimIdSet(claimsJson)}
    )`;
}

/** No child, live or trashed, of a claimed category stays outside the claimed set. */
export function categoriesHaveNoChildrenOutsideCondition(claimsJson: string): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM categories AS tree_child
        WHERE tree_child.parent_id IN ${claimIdSet(claimsJson)}
          AND tree_child.id NOT IN ${claimIdSet(claimsJson)}
    )`;
}

/** Every claimed category's parent is live or restored in the same claim set. */
export function categoriesHaveRestorableParentsCondition(claimsJson: string): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM categories AS tree_child
        INNER JOIN categories AS tree_parent ON tree_parent.id = tree_child.parent_id
        WHERE tree_child.id IN ${claimIdSet(claimsJson)}
          AND tree_parent.deleted_at IS NOT NULL
          AND tree_parent.id NOT IN ${claimIdSet(claimsJson)}
    )`;
}

export type CategoryTreeBlocker = { id: string; name: string; parentId: string | null };

/** Up to five children that keep the claimed categories from trash or deletion. */
export async function loadCategoryChildBlockers(
    db: Database,
    claimsJson: string,
    options: { liveOnly: boolean },
): Promise<CategoryTreeBlocker[]> {
    return db.all<CategoryTreeBlocker>(sql`
        SELECT tree_child.id AS id, tree_child.name AS name, tree_child.parent_id AS parentId
        FROM categories AS tree_child
        WHERE tree_child.parent_id IN ${claimIdSet(claimsJson)}
          AND tree_child.id NOT IN ${claimIdSet(claimsJson)}
          ${options.liveOnly ? sql`AND tree_child.deleted_at IS NULL` : sql``}
        ORDER BY tree_child.name, tree_child.id
        LIMIT 5`);
}

/** Up to five claimed categories whose parent is in trash and not restored with them. */
export async function loadCategoryTrashedParentBlockers(
    db: Database,
    claimsJson: string,
): Promise<CategoryTreeBlocker[]> {
    return db.all<CategoryTreeBlocker>(sql`
        SELECT tree_child.id AS id, tree_child.name AS name, tree_child.parent_id AS parentId
        FROM categories AS tree_child
        INNER JOIN categories AS tree_parent ON tree_parent.id = tree_child.parent_id
        WHERE tree_child.id IN ${claimIdSet(claimsJson)}
          AND tree_parent.deleted_at IS NOT NULL
          AND tree_parent.id NOT IN ${claimIdSet(claimsJson)}
        ORDER BY tree_child.name, tree_child.id
        LIMIT 5`);
}

// ─────────────────────────────────────────
// Admin tree reads (every status, live categories)
// ─────────────────────────────────────────

export type AdminCategoryTreeNode = {
    id: string;
    name: string;
    slug: string;
    status: "draft" | "published" | "internal";
    revision: number;
    parentId: string | null;
    depth: number;
    childCount: number;
};

/**
 * Live children of a category (null: the top level) for the dashboard's tree
 * and parent picker, one level at a time, in name order.
 */
export async function listCategoryChildren(
    db: Database,
    parentId: string | null,
    options: { limit?: number } = {},
): Promise<AdminCategoryTreeNode[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? CATEGORY_CHILDREN_LIMIT), 1), CATEGORY_CHILDREN_LIMIT);
    const rows = await db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            status: categories.status,
            revision: categories.revision,
            parentId: categories.parentId,
            depth: categories.depth,
            childCount: sql<number>`(
                SELECT count(*) FROM categories AS grandchild
                WHERE grandchild.parent_id = "categories"."id" AND grandchild.deleted_at IS NULL
            )`,
        })
        .from(categories)
        .where(and(
            parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
            isNull(categories.deletedAt),
        ))
        .orderBy(asc(categories.name), asc(categories.id))
        .limit(limit)
        .all();
    return rows.map((row) => ({ ...row, depth: Number(row.depth), childCount: Number(row.childCount ?? 0) }));
}

export type CategoryBreadcrumbItem = {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    depth: number;
};

/** A category's ancestors, root first, ending with the category (≤ 4 rows, one closure read). */
export async function getCategoryAncestors(db: Database, categoryId: string): Promise<CategoryBreadcrumbItem[]> {
    return ancestorsQuery(db, sql`${categoryId}`, false).all() as Promise<CategoryBreadcrumbItem[]>;
}

function ancestorsQuery(db: Database, descendantId: SQLWrapper, publicOnly: boolean) {
    return db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
            depth: categories.depth,
        })
        .from(categoryClosure)
        .innerJoin(categories, eq(categories.id, categoryClosure.ancestorId))
        .where(and(
            sql`${categoryClosure.descendantId} = ${descendantId}`,
            ...(publicOnly ? publicCategoryConditions() : []),
        ))
        .orderBy(desc(categoryClosure.depth));
}

// ─────────────────────────────────────────
// Storefront tree reads (published, live categories only)
// ─────────────────────────────────────────

/**
 * The published subtree of a category as a product condition: products in
 * the category or any published, live descendant. A draft or internal
 * descendant's products are not listed under the parent.
 */
export function publicCategorySubtreeCondition(productCategoryColumn: SQLWrapper, categoryId: string): SQL {
    return sql`${productCategoryColumn} IN (
        SELECT subtree.descendant_id
        FROM category_closure AS subtree
        INNER JOIN categories AS subtree_category
            ON subtree_category.id = subtree.descendant_id
           AND subtree_category.status = 'published'
           AND subtree_category.deleted_at IS NULL
        WHERE subtree.ancestor_id = ${categoryId}
    )`;
}

/** No ancestor of the category row is hidden (draft, internal or trashed). */
function everyAncestorPublicCondition(): SQL {
    return sql`NOT EXISTS (
        SELECT 1
        FROM category_closure AS lineage
        INNER JOIN categories AS lineage_category ON lineage_category.id = lineage.ancestor_id
        WHERE lineage.descendant_id = "categories"."id"
          AND lineage.depth > 0
          AND (lineage_category.status <> 'published' OR lineage_category.deleted_at IS NOT NULL)
    )`;
}

export type PublicCategoryTreeNode = {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    imageUrl: string | null;
    parentId: string | null;
    depth: number;
};

/**
 * The storefront's category tree for automatic menus: published categories
 * whose every ancestor is published, flat with `parentId`, top levels first
 * (depth, then name). At most {@link CATEGORY_TREE_LINK_LIMIT} nodes, so a
 * node's parent is always present when the node is; deeper levels live on
 * their category pages.
 */
export async function getPublicCategoryTree(db: Database): Promise<{
    nodes: PublicCategoryTreeNode[];
    truncated: boolean;
}> {
    const rows = await db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
            imageUrl: categories.imageUrl,
            parentId: categories.parentId,
            depth: categories.depth,
        })
        .from(categories)
        .where(and(...publicCategoryConditions(), everyAncestorPublicCondition()))
        .orderBy(asc(categories.depth), asc(categories.name), asc(categories.id))
        .limit(CATEGORY_TREE_LINK_LIMIT + 1)
        .all();
    return {
        nodes: rows.slice(0, CATEGORY_TREE_LINK_LIMIT).map((row) => ({ ...row, depth: Number(row.depth) })),
        truncated: rows.length > CATEGORY_TREE_LINK_LIMIT,
    };
}

export type PublicCategoryChild = {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    imageUrl: string | null;
};

function publicChildrenQuery(db: Database, parentId: SQLWrapper, limit: number) {
    return db
        .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
            imageUrl: categories.imageUrl,
        })
        .from(categories)
        .where(and(sql`${categories.parentId} = ${parentId}`, ...publicCategoryConditions()))
        .orderBy(asc(categories.name), asc(categories.id))
        .limit(limit);
}

const publishedIdBySlug = (slug: string) => sql`(
    SELECT tree_self.id FROM categories AS tree_self
    WHERE tree_self.slug = ${slug} AND tree_self.status = 'published' AND tree_self.deleted_at IS NULL
)`;

/** Published children of a published category (by slug), in name order. */
export async function getPublicCategoryChildren(
    db: Database,
    slug: string,
    options: { limit?: number } = {},
): Promise<PublicCategoryChild[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? CATEGORY_CHILDREN_LIMIT), 1), CATEGORY_CHILDREN_LIMIT);
    return publicChildrenQuery(db, publishedIdBySlug(slug), limit).all() as Promise<PublicCategoryChild[]>;
}

/**
 * The public breadcrumb of a published category (by slug): its published
 * ancestors root first, ending with the category. One closure read, ≤ 4 rows.
 */
export async function getPublicCategoryBreadcrumb(db: Database, slug: string): Promise<CategoryBreadcrumbItem[]> {
    const rows = await ancestorsQuery(db, publishedIdBySlug(slug), true).all() as CategoryBreadcrumbItem[];
    return rows.map((row) => ({ ...row, depth: Number(row.depth) }));
}

/**
 * The two tree reads a category page needs beside its own row, as batch
 * items keyed by the category's slug (so they share the page's round trip).
 */
export function publicCategoryTreeContextQueries(db: Database, slug: string, childLimit = CATEGORY_CHILDREN_LIMIT) {
    return {
        children: publicChildrenQuery(db, publishedIdBySlug(slug), childLimit),
        breadcrumb: ancestorsQuery(db, publishedIdBySlug(slug), true),
    } as const;
}
