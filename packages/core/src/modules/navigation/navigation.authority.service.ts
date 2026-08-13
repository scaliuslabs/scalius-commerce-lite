import {
    navigationMenuItems,
    navigationMenuPublicationItems,
    navigationMenuPublications,
    navigationMenus,
    navigationPlacements,
    siteSettings,
} from "@scalius/database/schema";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    and,
    asc,
    desc,
    eq,
    gt,
    inArray,
    isNull,
    lt,
    notExists,
    or,
    sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import {
    AppError,
    ConflictError,
    NotFoundError,
    ValidationError,
} from "@scalius/core/errors";
import type { NavigationTargetItem } from "@scalius/shared/navigation-target";
import {
    buildNavigationHierarchy,
    checksumNavigationPublication,
    getNavigationPlacementDefinition,
    NAVIGATION_MENU_ITEM_LIMIT,
    NAVIGATION_MENU_MAX_DEPTH,
    NAVIGATION_POSITION_GAP,
    NAVIGATION_SYSTEM_TARGETS,
    NavigationPlacementRevisionConflictError,
    NavigationRevisionConflictError,
    normalizeNavigationMenuHandle,
    normalizeNavigationMenuItemInput,
    normalizeNavigationMenuName,
    sparsePositionBetween,
    type NavigationHierarchyNode,
    type NavigationMenuItemInput,
    type NavigationMenuItemStorage,
} from "./navigation.authority";
import {
    chunkNavigationResourceIds,
    loadNavigationResourceSnapshots,
    resolveNavigationItemsForPublic,
} from "./navigation.resolver";
import { parseNavigationConfig } from "./navigation.validation";
import {
    ftsMatch,
    isFts5SearchEnabled,
    sanitizeFtsQuery,
} from "../../search/fts5";

const NAVIGATION_REVISION_GUARD = "NAVIGATION_REVISION_CONFLICT";
const NAVIGATION_PAGE_LIMIT = 100;

export interface NavigationMenuCursor {
    updatedAt: Date;
    id: string;
}

export interface NavigationItemCursor {
    position: number;
    id: string;
}

export interface NavigationItemDestination {
    parentId?: string | null;
    beforeId?: string;
    afterId?: string;
    index?: number;
}

export interface NavigationAuthorityShadowReport {
    ready: boolean;
    legacyMenuCount: number;
    authorityMenuCount: number;
    legacyItemCount: number;
    authorityItemCount: number;
    mismatches: string[];
}

function normalizeLimit(value: number | undefined): number {
    if (value == null) return 50;
    if (!Number.isInteger(value) || value < 1 || value > NAVIGATION_PAGE_LIMIT) {
        throw new ValidationError(`Navigation pages contain between 1 and ${NAVIGATION_PAGE_LIMIT} items.`);
    }
    return value;
}

function buildMenuRevisionGuard(
    db: Database,
    menuId: string,
    expectedRevision: number,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${navigationMenus}
            WHERE ${navigationMenus.id} = ${menuId}
              AND ${navigationMenus.revision} = ${expectedRevision}
              AND ${navigationMenus.deletedAt} IS NULL
        )`, NAVIGATION_REVISION_GUARD);
}

function buildMenuItemRevisionGuard(
    db: Database,
    menuId: string,
    itemId: string,
    expectedRevision: number,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${navigationMenus}
            WHERE ${navigationMenus.id} = ${menuId}
              AND ${navigationMenus.revision} = ${expectedRevision}
              AND ${navigationMenus.deletedAt} IS NULL
              AND EXISTS (
                  SELECT 1 FROM ${navigationMenuItems}
                  WHERE ${navigationMenuItems.id} = ${itemId}
                    AND ${navigationMenuItems.menuId} = ${menuId}
              )
        )`, NAVIGATION_REVISION_GUARD);
}

function buildTrashedMenuRevisionGuard(
    db: Database,
    menuId: string,
    expectedRevision: number,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${navigationMenus}
            WHERE ${navigationMenus.id} = ${menuId}
              AND ${navigationMenus.revision} = ${expectedRevision}
              AND ${navigationMenus.deletedAt} IS NOT NULL
        )`, NAVIGATION_REVISION_GUARD);
}

function buildMenuRevisionBump(
    db: Database,
    menuId: string,
): BatchItem<"sqlite"> {
    return db
        .update(navigationMenus)
        .set({
            revision: sql`${navigationMenus.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(navigationMenus.id, menuId))
        .returning({ revision: navigationMenus.revision });
}

function isRevisionGuardError(error: unknown): boolean {
    return isBatchGuardError(error, NAVIGATION_REVISION_GUARD);
}

async function rethrowNavigationMutationError(
    db: Database,
    menuId: string,
    expectedRevision: number,
    error: unknown,
): Promise<never> {
    if (isRevisionGuardError(error)) {
        const current = await db
            .select({
                revision: navigationMenus.revision,
                deletedAt: navigationMenus.deletedAt,
            })
            .from(navigationMenus)
            .where(eq(navigationMenus.id, menuId))
            .get();
        throw new NavigationRevisionConflictError(
            menuId,
            expectedRevision,
            current?.revision ?? null,
        );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/navigation_menus_active_handle_unique|UNIQUE constraint failed.*navigation_menus/i.test(message)) {
        throw new ConflictError("An active menu already uses this handle.");
    }
    throw error;
}

function readRevisionResult(value: unknown): number {
    const first = Array.isArray(value) ? value[0] : undefined;
    const revision = first && typeof first === "object"
        ? (first as { revision?: unknown }).revision
        : undefined;
    if (!Number.isInteger(revision) || (revision as number) < 1) {
        throw new ConflictError("The menu change could not be confirmed. Reload the menu and try again.");
    }
    return revision as number;
}

async function executeMenuMutation(
    db: Database,
    menuId: string,
    expectedRevision: number,
    statements: BatchItem<"sqlite">[],
): Promise<{ revision: number; results: unknown[] }> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ValidationError("A current menu revision is required.");
    }
    try {
        const results = await safeBatch(db, [
            buildMenuRevisionGuard(db, menuId, expectedRevision),
            ...statements,
            buildMenuRevisionBump(db, menuId),
        ] as never) as unknown[];
        return {
            revision: readRevisionResult(results.at(-1)),
            results: results.slice(1, -1),
        };
    } catch (error) {
        return rethrowNavigationMutationError(db, menuId, expectedRevision, error);
    }
}

async function executeMenuItemMutation(
    db: Database,
    menuId: string,
    itemId: string,
    expectedRevision: number,
    statement: BatchItem<"sqlite">,
): Promise<{ revision: number; result: unknown }> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ValidationError("A current menu revision is required.");
    }
    try {
        const results = await safeBatch(db, [
            buildMenuItemRevisionGuard(db, menuId, itemId, expectedRevision),
            statement,
            buildMenuRevisionBump(db, menuId),
        ] as never) as unknown[];
        return {
            revision: readRevisionResult(results[2]),
            result: results[1],
        };
    } catch (error) {
        if (isRevisionGuardError(error)) {
            const current = await db
                .select({
                    revision: navigationMenus.revision,
                    deletedAt: navigationMenus.deletedAt,
                })
                .from(navigationMenus)
                .where(eq(navigationMenus.id, menuId))
                .get();
            if (current?.revision === expectedRevision && current.deletedAt == null) {
                throw new NotFoundError("Menu item not found.");
            }
        }
        return rethrowNavigationMutationError(db, menuId, expectedRevision, error);
    }
}

export async function createNavigationMenu(
    db: Database,
    input: { name: string; handle?: string },
) {
    const name = normalizeNavigationMenuName(input.name);
    const handle = normalizeNavigationMenuHandle(input.handle ?? name);
    try {
        const row = await db
            .insert(navigationMenus)
            .values({
                id: `menu_${nanoid()}`,
                name,
                handle,
            })
            .returning()
            .get();
        if (!row) throw new ConflictError("The menu could not be created.");
        return row;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/navigation_menus_active_handle_unique|UNIQUE constraint failed.*navigation_menus/i.test(message)) {
            throw new ConflictError("An active menu already uses this handle.");
        }
        throw error;
    }
}

export async function listNavigationMenus(
    db: Database,
    input: { limit?: number; cursor?: NavigationMenuCursor; includeTrash?: boolean } = {},
) {
    const limit = normalizeLimit(input.limit);
    const conditions = [];
    if (!input.includeTrash) conditions.push(isNull(navigationMenus.deletedAt));
    if (input.cursor) {
        conditions.push(or(
            lt(navigationMenus.updatedAt, input.cursor.updatedAt),
            and(
                eq(navigationMenus.updatedAt, input.cursor.updatedAt),
                gt(navigationMenus.id, input.cursor.id),
            ),
        ));
    }
    const rows = await db
        .select({
            id: navigationMenus.id,
            name: navigationMenus.name,
            handle: navigationMenus.handle,
            revision: navigationMenus.revision,
            publishedRevision: navigationMenus.publishedRevision,
            dependencyRevision: navigationMenus.dependencyRevision,
            updatedAt: navigationMenus.updatedAt,
            deletedAt: navigationMenus.deletedAt,
            itemCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuItems}
                WHERE ${navigationMenuItems.menuId} = ${sql.raw("navigation_menus.id")}
            )`,
            placementCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationPlacements}
                WHERE ${navigationPlacements.menuId} = ${sql.raw("navigation_menus.id")}
                  AND ${navigationPlacements.isEnabled} = true
            )`,
        })
        .from(navigationMenus)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(navigationMenus.updatedAt), asc(navigationMenus.id))
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
        items,
        nextCursor: hasMore && last
            ? { updatedAt: last.updatedAt, id: last.id }
            : null,
    };
}

export async function getNavigationMenuAuthority(db: Database, menuId: string) {
    const menu = await db
        .select()
        .from(navigationMenus)
        .where(eq(navigationMenus.id, menuId))
        .get();
    if (!menu) throw new NotFoundError("Menu not found.");
    return menu;
}

export async function listNavigationMenuPublications(
    db: Database,
    menuId: string,
    input: { limit?: number; beforeRevision?: number } = {},
) {
    await getNavigationMenuAuthority(db, menuId);
    const limit = normalizeLimit(input.limit);
    if (input.beforeRevision != null && (!Number.isInteger(input.beforeRevision) || input.beforeRevision < 1)) {
        throw new ValidationError("Invalid publication cursor.");
    }
    const rows = await db
        .select()
        .from(navigationMenuPublications)
        .where(and(
            eq(navigationMenuPublications.menuId, menuId),
            input.beforeRevision == null
                ? undefined
                : lt(navigationMenuPublications.revision, input.beforeRevision),
        ))
        .orderBy(desc(navigationMenuPublications.revision))
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
        items,
        nextCursor: hasMore ? items.at(-1)?.revision ?? null : null,
    };
}

export async function updateNavigationMenuMetadata(
    db: Database,
    menuId: string,
    input: { expectedRevision: number; name: string; handle: string },
) {
    const name = normalizeNavigationMenuName(input.name);
    const handle = normalizeNavigationMenuHandle(input.handle);
    const mutation = await executeMenuMutation(db, menuId, input.expectedRevision, [
        db.update(navigationMenus)
            .set({ name, handle, updatedAt: sql`unixepoch()` })
            .where(eq(navigationMenus.id, menuId))
            .returning({ id: navigationMenus.id }),
    ] as never);
    if (!(mutation.results[0] as unknown[] | undefined)?.length) {
        throw new NotFoundError("Menu not found.");
    }
    return { revision: mutation.revision, name, handle };
}

export async function trashNavigationMenu(
    db: Database,
    menuId: string,
    input: { expectedRevision: number },
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (menu.deletedAt) throw new ConflictError("This menu is already in Trash.");
    if (menu.revision !== input.expectedRevision) {
        throw new NavigationRevisionConflictError(menuId, input.expectedRevision, menu.revision);
    }
    try {
        const results = await safeBatch(db, [
            buildMenuRevisionGuard(db, menuId, input.expectedRevision),
            db.update(navigationMenus)
                .set({
                    deletedAt: sql`unixepoch()`,
                    revision: sql`${navigationMenus.revision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(navigationMenus.id, menuId),
                    notExists(db
                        .select({ id: navigationPlacements.id })
                        .from(navigationPlacements)
                        .where(and(
                            eq(navigationPlacements.menuId, menuId),
                            eq(navigationPlacements.isEnabled, true),
                        ))),
                ))
                .returning({ revision: navigationMenus.revision }),
        ] as never) as unknown[];
        const trashedMenus = results.at(-1) as unknown[] | undefined;
        if (!trashedMenus?.length) {
            throw new ConflictError("Remove this menu from its storefront locations before moving it to Trash.");
        }
        return { revision: readRevisionResult(trashedMenus) };
    } catch (error) {
        if (error instanceof ConflictError) throw error;
        return rethrowNavigationMutationError(db, menuId, input.expectedRevision, error);
    }
}

export async function restoreNavigationMenu(
    db: Database,
    menuId: string,
    input: { expectedRevision: number },
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (!menu.deletedAt) throw new ConflictError("This menu is not in Trash.");
    if (menu.revision !== input.expectedRevision) {
        throw new NavigationRevisionConflictError(menuId, input.expectedRevision, menu.revision);
    }
    try {
        const results = await safeBatch(db, [
            buildTrashedMenuRevisionGuard(db, menuId, input.expectedRevision),
            db.update(navigationMenus)
                .set({
                    deletedAt: null,
                    revision: sql`${navigationMenus.revision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(navigationMenus.id, menuId))
                .returning({ revision: navigationMenus.revision }),
        ] as never) as unknown[];
        return { revision: readRevisionResult(results.at(-1)) };
    } catch (error) {
        return rethrowNavigationMutationError(db, menuId, input.expectedRevision, error);
    }
}

export async function listNavigationMenuItems(
    db: Database,
    menuId: string,
    input: { parentId?: string | null; limit?: number; cursor?: NavigationItemCursor } = {},
) {
    const limit = normalizeLimit(input.limit);
    const parentId = input.parentId ?? null;
    const conditions = [eq(navigationMenuItems.menuId, menuId)];
    conditions.push(parentId == null
        ? isNull(navigationMenuItems.parentId)
        : eq(navigationMenuItems.parentId, parentId));
    if (input.cursor) {
        const cursorCondition = or(
            gt(navigationMenuItems.position, input.cursor.position),
            and(
                eq(navigationMenuItems.position, input.cursor.position),
                gt(navigationMenuItems.id, input.cursor.id),
            ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
    }
    const rows = await db
        .select({
            item: navigationMenuItems,
            childCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuItems} AS child
                WHERE child.menu_id = ${menuId}
                  AND child.parent_id = ${sql.raw("navigation_menu_items.id")}
            )`,
        })
        .from(navigationMenuItems)
        .where(and(...conditions))
        .orderBy(asc(navigationMenuItems.position), asc(navigationMenuItems.id))
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1)?.item;
    return {
        items,
        nextCursor: hasMore && last
            ? { position: last.position, id: last.id }
            : null,
    };
}

export async function getNavigationMenuItemAuthority(
    db: Database,
    menuId: string,
    itemId: string,
) {
    const row = await db
        .select({
            item: navigationMenuItems,
            childCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuItems} AS child
                WHERE child.menu_id = ${menuId}
                  AND child.parent_id = ${sql.raw("navigation_menu_items.id")}
            )`,
        })
        .from(navigationMenuItems)
        .where(and(
            eq(navigationMenuItems.menuId, menuId),
            eq(navigationMenuItems.id, itemId),
        ))
        .get();
    if (!row) throw new NotFoundError("Menu item not found.");
    return row;
}

export async function getNavigationMenuMoveOptions(
    db: Database,
    menuId: string,
    itemId: string,
    input: {
        query?: string;
        limit?: number;
        selectedParentId?: string | null;
    } = {},
) {
    await getNavigationMenuAuthority(db, menuId);
    const rows = await db
        .select({
            id: navigationMenuItems.id,
            parentId: navigationMenuItems.parentId,
            position: navigationMenuItems.position,
            label: navigationMenuItems.label,
        })
        .from(navigationMenuItems)
        .where(eq(navigationMenuItems.menuId, menuId))
        .limit(NAVIGATION_MENU_ITEM_LIMIT + 1)
        .all();
    if (rows.length > NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError(`A menu can contain at most ${NAVIGATION_MENU_ITEM_LIMIT} items.`);
    }

    const hierarchy = buildNavigationHierarchy(rows);
    const nodes = flattenHierarchy(hierarchy);
    const movingNode = nodes.find((node) => node.item.id === itemId);
    if (!movingNode) throw new NotFoundError("Menu item not found.");

    const query = input.query?.trim() ?? "";
    if (query && (query.length < 2 || query.length > 100)) {
        throw new ValidationError("Search with 2–100 characters.");
    }
    const limit = normalizeLimit(input.limit ?? 50);
    const movingDepth = subtreeDepth(movingNode);
    const blockedIds = new Set(flattenHierarchy([movingNode]).map((node) => node.item.id));
    const nodeById = new Map(nodes.map((node) => [node.item.id, node]));
    const pathLabel = (node: NavigationHierarchyNode<(typeof rows)[number]>): string => {
        const labels = [node.item.label];
        let parentId = node.item.parentId;
        while (parentId) {
            const parent = nodeById.get(parentId);
            if (!parent) break;
            labels.unshift(parent.item.label);
            parentId = parent.item.parentId;
        }
        return labels.join(" › ");
    };
    const validParents = nodes.filter((node) => (
        !blockedIds.has(node.item.id)
        && node.depth + movingDepth <= NAVIGATION_MENU_MAX_DEPTH
    ));
    const validParentById = new Map(validParents.map((node) => [node.item.id, node]));
    const selectedParentId = input.selectedParentId === undefined
        ? movingNode.item.parentId
        : input.selectedParentId;
    if (selectedParentId && !validParentById.has(selectedParentId)) {
        throw new ValidationError("Choose a depth-safe parent outside the moving branch.");
    }

    const currentSiblings = rows
        .filter((row) => row.parentId === movingNode.item.parentId)
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const currentPosition = currentSiblings.findIndex((row) => row.id === itemId) + 1;
    const destinationSiblings = rows.filter((row) => (
        row.parentId === selectedParentId && row.id !== itemId
    ));
    const normalizedQuery = query.toLocaleLowerCase();
    const matches = validParents
        .map((node) => ({ node, path: pathLabel(node) }))
        .filter(({ node, path }) => !normalizedQuery || (
            node.item.label.toLocaleLowerCase().includes(normalizedQuery)
            || path.toLocaleLowerCase().includes(normalizedQuery)
        ))
        .sort((left, right) => left.path.localeCompare(right.path) || left.node.item.id.localeCompare(right.node.item.id));
    const forcedIds = [movingNode.item.parentId, selectedParentId].filter(
        (id): id is string => Boolean(id),
    );
    const selectedNodes = [
        ...forcedIds.flatMap((id) => {
            const node = validParentById.get(id);
            return node ? [{ node, path: pathLabel(node) }] : [];
        }),
        ...matches,
    ];
    const seen = new Set<string>();
    const parents = selectedNodes.flatMap(({ node, path }) => {
        if (seen.has(node.item.id) || seen.size >= limit) return [];
        seen.add(node.item.id);
        return [{
            id: node.item.id,
            label: node.item.label,
            pathLabel: path,
            resultingLevel: node.depth + 1,
            childCount: node.children.length,
        }];
    });

    return {
        item: {
            id: movingNode.item.id,
            label: movingNode.item.label,
            parentId: movingNode.item.parentId,
        },
        subtreeDepth: movingDepth,
        currentPosition,
        selectedParentId,
        positionCount: destinationSiblings.length + 1,
        parents,
    };
}

export async function searchNavigationMenuItems(
    db: Database,
    menuId: string,
    input: { query: string; limit?: number },
) {
    await getNavigationMenuAuthority(db, menuId);
    const query = input.query.trim();
    if (query.length < 2 || query.length > 100) {
        throw new ValidationError("Search with 2–100 characters.");
    }
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return { items: [] };
    const limit = normalizeLimit(input.limit ?? 50);
    const fts5Enabled = isFts5SearchEnabled(db);
    const searchCondition = ftsMatch(
        db,
        "navigation_menu_items_fts",
        "navigation_menu_items",
        query,
    );
    if (!searchCondition) return { items: [] };
    const matches = await db
        .select({
            item: navigationMenuItems,
            childCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuItems} AS child
                WHERE child.menu_id = ${menuId}
                  AND child.parent_id = ${sql.raw("navigation_menu_items.id")}
            )`,
        })
        .from(navigationMenuItems)
        .where(and(
            eq(navigationMenuItems.menuId, menuId),
            searchCondition,
        ))
        .orderBy(
            fts5Enabled
                ? sql`(
                    SELECT rank FROM navigation_menu_items_fts
                    WHERE rowid = ${sql.raw("navigation_menu_items")}.rowid
                      AND navigation_menu_items_fts MATCH ${sanitized}
                ) ASC`
                : asc(navigationMenuItems.label),
            asc(navigationMenuItems.position),
            asc(navigationMenuItems.id),
        )
        .limit(limit)
        .all();

    const rowsById = new Map(matches.map(({ item, childCount }) => [
        item.id,
        { item, childCount, isMatch: true },
    ]));
    let parentIds = [...new Set(matches.map(({ item }) => item.parentId).filter(
        (id): id is string => Boolean(id),
    ))];
    for (let depth = 0; depth < 2 && parentIds.length; depth += 1) {
        const parents = await db
            .select({
                item: navigationMenuItems,
                childCount: sql<number>`(
                    SELECT COUNT(*) FROM ${navigationMenuItems} AS child
                    WHERE child.menu_id = ${menuId}
                      AND child.parent_id = ${sql.raw("navigation_menu_items.id")}
                )`,
            })
            .from(navigationMenuItems)
            .where(and(
                eq(navigationMenuItems.menuId, menuId),
                inArray(navigationMenuItems.id, parentIds),
            ))
            .all();
        parentIds = [];
        for (const { item, childCount } of parents) {
            if (!rowsById.has(item.id)) {
                rowsById.set(item.id, { item, childCount, isMatch: false });
            }
            if (item.parentId) parentIds.push(item.parentId);
        }
        parentIds = [...new Set(parentIds)];
    }
    return {
        items: [...rowsById.values()].sort((left, right) => (
            left.item.position - right.item.position
            || left.item.id.localeCompare(right.item.id)
        )),
    };
}

async function assertParentAcceptsItem(
    db: Database,
    menuId: string,
    parentId: string | null,
    movingItemId?: string,
): Promise<void> {
    if (!parentId) return;
    let currentId: string | null = parentId;
    let newDepth = 2;
    while (currentId) {
        if (currentId === movingItemId) {
            throw new ValidationError("A menu item cannot move inside itself or one of its descendants.");
        }
        const parent: { id: string; menuId: string; parentId: string | null } | undefined = await db
            .select({
                id: navigationMenuItems.id,
                menuId: navigationMenuItems.menuId,
                parentId: navigationMenuItems.parentId,
            })
            .from(navigationMenuItems)
            .where(eq(navigationMenuItems.id, currentId))
            .get();
        if (!parent || parent.menuId !== menuId) {
            throw new ValidationError("Choose a parent from this menu.");
        }
        currentId = parent.parentId;
        if (currentId) newDepth += 1;
        if (newDepth > 3) throw new ValidationError("Menus support at most three levels.");
    }
}

async function nextAppendPosition(
    db: Database,
    menuId: string,
    parentId: string | null,
): Promise<number> {
    const [last] = await db
        .select({ position: navigationMenuItems.position })
        .from(navigationMenuItems)
        .where(and(
            eq(navigationMenuItems.menuId, menuId),
            parentId == null
                ? isNull(navigationMenuItems.parentId)
                : eq(navigationMenuItems.parentId, parentId),
        ))
        .orderBy(desc(navigationMenuItems.position), desc(navigationMenuItems.id))
        .limit(1)
        .all();
    const position = sparsePositionBetween(last?.position ?? null, null);
    if (position == null) throw new ConflictError("This sibling set needs position maintenance before another item can be appended.");
    return position;
}

export async function createNavigationMenuItem(
    db: Database,
    menuId: string,
    input: NavigationMenuItemInput & {
        expectedRevision: number;
        parentId?: string | null;
    },
) {
    const normalized = normalizeNavigationMenuItemInput(input);
    const parentId = input.parentId ?? null;
    await assertParentAcceptsItem(db, menuId, parentId);
    const countRow = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(navigationMenuItems)
        .where(eq(navigationMenuItems.menuId, menuId))
        .get();
    if ((countRow?.count ?? 0) >= NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError(`A menu can contain at most ${NAVIGATION_MENU_ITEM_LIMIT} items.`);
    }
    const id = `navitem_${nanoid()}`;
    const position = await nextAppendPosition(db, menuId, parentId);
    const mutation = await executeMenuMutation(db, menuId, input.expectedRevision, [
        db.insert(navigationMenuItems).values({
            id,
            menuId,
            parentId,
            position,
            ...normalized,
        }).returning(),
    ] as never);
    return {
        item: (mutation.results[0] as unknown[] | undefined)?.[0],
        revision: mutation.revision,
    };
}

export async function updateNavigationMenuItem(
    db: Database,
    menuId: string,
    itemId: string,
    input: NavigationMenuItemInput & { expectedRevision: number },
) {
    const normalized = normalizeNavigationMenuItemInput(input);
    const mutation = await executeMenuItemMutation(db, menuId, itemId, input.expectedRevision,
        db.update(navigationMenuItems)
            .set({ ...normalized, updatedAt: sql`unixepoch()` })
            .where(and(
                eq(navigationMenuItems.id, itemId),
                eq(navigationMenuItems.menuId, menuId),
            ))
            .returning(),
    );
    const item = (mutation.result as unknown[] | undefined)?.[0];
    if (!item) throw new NotFoundError("Menu item not found.");
    return { item, revision: mutation.revision };
}

function flattenHierarchy<T extends { id: string; parentId: string | null; position: number }>(
    nodes: readonly NavigationHierarchyNode<T>[],
): NavigationHierarchyNode<T>[] {
    return nodes.flatMap((node) => [node, ...flattenHierarchy(node.children)]);
}

function subtreeDepth<T extends { id: string; parentId: string | null; position: number }>(
    node: NavigationHierarchyNode<T>,
): number {
    return node.children.length
        ? 1 + Math.max(...node.children.map(subtreeDepth))
        : 1;
}

export async function moveNavigationMenuItem(
    db: Database,
    menuId: string,
    itemId: string,
    input: NavigationItemDestination & { expectedRevision: number },
) {
    const destinationModes = [
        Boolean(input.beforeId),
        Boolean(input.afterId),
        input.index != null,
    ].filter(Boolean).length;
    if (destinationModes > 1) {
        throw new ValidationError("Choose one exact move destination.");
    }
    if (input.index != null && (!Number.isInteger(input.index) || input.index < 0)) {
        throw new ValidationError("Choose a valid destination position.");
    }
    const hierarchyRows = await db
        .select({
            id: navigationMenuItems.id,
            parentId: navigationMenuItems.parentId,
            position: navigationMenuItems.position,
        })
        .from(navigationMenuItems)
        .where(eq(navigationMenuItems.menuId, menuId))
        .all();
    const hierarchy = buildNavigationHierarchy(hierarchyRows);
    const nodes = flattenHierarchy(hierarchy);
    const movingNode = nodes.find((node) => node.item.id === itemId);
    if (!movingNode) throw new NotFoundError("Menu item not found.");

    const parentId = input.parentId ?? null;
    await assertParentAcceptsItem(db, menuId, parentId, itemId);
    const parentNode = parentId ? nodes.find((node) => node.item.id === parentId) : undefined;
    const destinationDepth = parentNode ? parentNode.depth + 1 : 1;
    if (destinationDepth + subtreeDepth(movingNode) - 1 > 3) {
        throw new ValidationError("This move would create more than three menu levels.");
    }

    const siblings = hierarchyRows
        .filter((row) => row.parentId === parentId && row.id !== itemId)
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    let insertionIndex = siblings.length;
    if (input.index != null) {
        if (input.index > siblings.length) {
            throw new ValidationError("The destination position is outside this parent.");
        }
        insertionIndex = input.index;
    } else if (input.beforeId) {
        insertionIndex = siblings.findIndex((row) => row.id === input.beforeId);
        if (insertionIndex < 0) throw new ValidationError("The before destination is not a sibling in this location.");
    } else if (input.afterId) {
        const index = siblings.findIndex((row) => row.id === input.afterId);
        if (index < 0) throw new ValidationError("The after destination is not a sibling in this location.");
        insertionIndex = index + 1;
    }

    const previous = siblings[insertionIndex - 1]?.position ?? null;
    const next = siblings[insertionIndex]?.position ?? null;
    const sparsePosition = sparsePositionBetween(previous, next);
    let statement: BatchItem<"sqlite">;
    if (sparsePosition != null) {
        statement = db.update(navigationMenuItems)
            .set({
                parentId,
                position: sparsePosition,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(navigationMenuItems.menuId, menuId),
                eq(navigationMenuItems.id, itemId),
            ));
    } else {
        const orderedIds = siblings.map((row) => row.id);
        orderedIds.splice(insertionIndex, 0, itemId);
        const compacted = JSON.stringify(orderedIds.map((id, index) => ({
            id,
            position: (index + 1) * NAVIGATION_POSITION_GAP,
        })));
        statement = db.update(navigationMenuItems)
            .set({
                parentId: sql`CASE WHEN ${navigationMenuItems.id} = ${itemId} THEN ${parentId} ELSE ${navigationMenuItems.parentId} END`,
                position: sql`(
                    SELECT CAST(json_extract(value, '$.position') AS INTEGER)
                    FROM json_each(${compacted})
                    WHERE json_extract(value, '$.id') = ${navigationMenuItems.id}
                )`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(navigationMenuItems.menuId, menuId),
                sql`${navigationMenuItems.id} IN (
                    SELECT json_extract(value, '$.id') FROM json_each(${compacted})
                )`,
            ));
    }

    const result = await executeMenuMutation(db, menuId, input.expectedRevision, [statement]);
    return { revision: result.revision };
}

export async function deleteNavigationMenuItem(
    db: Database,
    menuId: string,
    itemId: string,
    expectedRevision: number,
) {
    const rows = await db
        .select({
            id: navigationMenuItems.id,
            parentId: navigationMenuItems.parentId,
        })
        .from(navigationMenuItems)
        .where(eq(navigationMenuItems.menuId, menuId))
        .limit(NAVIGATION_MENU_ITEM_LIMIT + 1)
        .all();
    if (rows.length > NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError(`A menu can contain at most ${NAVIGATION_MENU_ITEM_LIMIT} items.`);
    }
    if (!rows.some((row) => row.id === itemId)) {
        throw new NotFoundError("Menu item not found.");
    }

    const childrenByParent = new Map<string, string[]>();
    for (const row of rows) {
        if (!row.parentId) continue;
        const children = childrenByParent.get(row.parentId) ?? [];
        children.push(row.id);
        childrenByParent.set(row.parentId, children);
    }
    const subtreeIds = [itemId];
    const seen = new Set(subtreeIds);
    for (let index = 0; index < subtreeIds.length; index += 1) {
        for (const childId of childrenByParent.get(subtreeIds[index]!) ?? []) {
            if (seen.has(childId)) continue;
            seen.add(childId);
            subtreeIds.push(childId);
        }
    }

    const encodedSubtreeIds = JSON.stringify(subtreeIds);
    const result = await executeMenuMutation(db, menuId, expectedRevision, [
        db.delete(navigationMenuItems)
            .where(and(
                eq(navigationMenuItems.menuId, menuId),
                sql`${navigationMenuItems.id} IN (
                    SELECT value FROM json_each(${encodedSubtreeIds})
                )`,
            ))
            .returning({ id: navigationMenuItems.id }),
    ] as never);
    const deleted = result.results[0] as unknown[] | undefined;
    if (!deleted?.length) throw new NotFoundError("Menu item not found.");
    return { deletedCount: deleted.length, revision: result.revision };
}

type AuthorityProjectionRow = NavigationMenuItemStorage & {
    id: string;
    parentId: string | null;
    position: number;
};

function authorityRowToTargetItem(row: AuthorityProjectionRow): NavigationTargetItem {
    const common = {
        id: row.id,
        labelMode: row.labelMode,
        ...(row.labelMode === "custom" ? { customLabel: row.label } : {}),
        lastKnownLabel: row.label,
        ...(row.openInNewTab ? { openInNewTab: true } : {}),
    } satisfies Omit<NavigationTargetItem, "target">;

    if (["page", "category", "collection", "product"].includes(row.targetType)) {
        return {
            ...common,
            target: {
                type: "resource",
                resourceType: row.targetType as "page" | "category" | "collection" | "product",
                resourceId: row.targetId!,
                ...(row.targetQuery ? { query: row.targetQuery } : {}),
            },
        };
    }
    if (row.targetType === "system") {
        const path = NAVIGATION_SYSTEM_TARGETS[
            row.targetValue as keyof typeof NAVIGATION_SYSTEM_TARGETS
        ];
        return { ...common, target: { type: "internal_path", path: path ?? "/" } };
    }
    if (row.targetType === "internal_path") {
        return { ...common, target: { type: "internal_path", path: row.targetValue! } };
    }
    if (row.targetType === "external_url") {
        return { ...common, target: { type: "external_url", url: row.targetValue! } };
    }
    return { ...common, target: { type: "label" } };
}

async function validateNavigationRowsForPublication(
    db: Database,
    rows: readonly AuthorityProjectionRow[],
): Promise<void> {
    buildNavigationHierarchy(rows);
    const enabledResources = rows
        .filter((item) => item.isEnabled)
        .filter((item) => ["page", "category", "collection", "product"].includes(item.targetType))
        .map(authorityRowToTargetItem);
    const resources = await loadNavigationResourceSnapshots(
        db,
        { navigation: enabledResources },
        {},
    );
    const unavailable = enabledResources.filter((item) => {
        if (item.target.type !== "resource") return false;
        return resources.get(`${item.target.resourceType}:${item.target.resourceId}`)?.readiness !== "ready";
    });
    if (unavailable.length) {
        throw new ValidationError(
            "Resolve unavailable page, category, collection, or product links before publishing.",
            { itemIds: unavailable.slice(0, 20).map((item) => item.id), total: unavailable.length },
        );
    }
    for (const item of rows) {
        if (item.targetType === "system" && !(item.targetValue! in NAVIGATION_SYSTEM_TARGETS)) {
            throw new ValidationError(`Menu item ${item.id} uses an unsupported storefront destination.`);
        }
    }
}

export async function publishNavigationMenu(
    db: Database,
    menuId: string,
    input: { expectedRevision: number; publishedBy?: string | null },
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (menu.deletedAt) throw new ConflictError("Restore this menu before publishing it.");
    if (menu.revision !== input.expectedRevision) {
        throw new NavigationRevisionConflictError(menuId, input.expectedRevision, menu.revision);
    }
    const items = await db
        .select()
        .from(navigationMenuItems)
        .where(eq(navigationMenuItems.menuId, menuId))
        .orderBy(asc(navigationMenuItems.position), asc(navigationMenuItems.id))
        .limit(NAVIGATION_MENU_ITEM_LIMIT + 1)
        .all();
    if (items.length > NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError(`A menu can contain at most ${NAVIGATION_MENU_ITEM_LIMIT} items.`);
    }
    await validateNavigationRowsForPublication(db, items);

    const checksum = await checksumNavigationPublication(items);
    const publishedRevision = input.expectedRevision + 1;
    const publicationInsert = db.insert(navigationMenuPublications).values({
        menuId,
        revision: publishedRevision,
        publishedBy: input.publishedBy ?? null,
        itemCount: items.length,
        checksum,
    });
    const publicationItemsInsert = db
        .insert(navigationMenuPublicationItems)
        .select(db.select({
            menuId: navigationMenuItems.menuId,
            revision: sql<number>`${publishedRevision}`.as("revision"),
            itemId: navigationMenuItems.id,
            parentId: navigationMenuItems.parentId,
            position: navigationMenuItems.position,
            label: navigationMenuItems.label,
            labelMode: navigationMenuItems.labelMode,
            targetType: navigationMenuItems.targetType,
            targetId: navigationMenuItems.targetId,
            targetValue: navigationMenuItems.targetValue,
            targetQuery: navigationMenuItems.targetQuery,
            openInNewTab: navigationMenuItems.openInNewTab,
            isEnabled: navigationMenuItems.isEnabled,
        }).from(navigationMenuItems).where(eq(navigationMenuItems.menuId, menuId)));
    try {
        const results = await safeBatch(db, [
            buildMenuRevisionGuard(db, menuId, input.expectedRevision),
            publicationInsert,
            publicationItemsInsert,
            db.update(navigationMenus)
                .set({
                    revision: publishedRevision,
                    publishedRevision,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(navigationMenus.id, menuId),
                    eq(navigationMenus.revision, input.expectedRevision),
                ))
                .returning({ revision: navigationMenus.revision }),
        ] as never) as unknown[];
        return {
            revision: readRevisionResult(results.at(-1)),
            publishedRevision,
            itemCount: items.length,
            checksum,
        };
    } catch (error) {
        return rethrowNavigationMutationError(db, menuId, input.expectedRevision, error);
    }
}

export async function rollbackNavigationMenu(
    db: Database,
    menuId: string,
    input: {
        expectedRevision: number;
        sourceRevision: number;
        publishedBy?: string | null;
    },
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (menu.deletedAt) throw new ConflictError("Restore this menu before rolling it back.");
    if (menu.revision !== input.expectedRevision) {
        throw new NavigationRevisionConflictError(menuId, input.expectedRevision, menu.revision);
    }
    if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 1) {
        throw new ValidationError("Choose a valid published menu revision.");
    }
    const sourcePublication = await db
        .select()
        .from(navigationMenuPublications)
        .where(and(
            eq(navigationMenuPublications.menuId, menuId),
            eq(navigationMenuPublications.revision, input.sourceRevision),
        ))
        .get();
    if (!sourcePublication) throw new NotFoundError("Published menu revision not found.");

    const sourceRows = await db
        .select()
        .from(navigationMenuPublicationItems)
        .where(and(
            eq(navigationMenuPublicationItems.menuId, menuId),
            eq(navigationMenuPublicationItems.revision, input.sourceRevision),
        ))
        .orderBy(
            asc(navigationMenuPublicationItems.position),
            asc(navigationMenuPublicationItems.itemId),
        )
        .limit(NAVIGATION_MENU_ITEM_LIMIT + 1)
        .all();
    if (sourceRows.length !== sourcePublication.itemCount) {
        throw new ConflictError("This published menu revision is incomplete and cannot be restored.");
    }
    const authorityRows: AuthorityProjectionRow[] = sourceRows.map((row) => ({
        id: row.itemId,
        parentId: row.parentId,
        position: row.position,
        label: row.label,
        labelMode: row.labelMode,
        targetType: row.targetType,
        targetId: row.targetId,
        targetValue: row.targetValue,
        targetQuery: row.targetQuery,
        openInNewTab: row.openInNewTab,
        isEnabled: row.isEnabled,
    }));
    await validateNavigationRowsForPublication(db, authorityRows);
    const checksum = await checksumNavigationPublication(authorityRows);
    if (checksum !== sourcePublication.checksum) {
        throw new ConflictError("This published menu revision failed its integrity check.");
    }

    const publishedRevision = input.expectedRevision + 1;
    try {
        const results = await safeBatch(db, [
            buildMenuRevisionGuard(db, menuId, input.expectedRevision),
            db.delete(navigationMenuItems).where(eq(navigationMenuItems.menuId, menuId)),
            db.insert(navigationMenuItems).select(db.select({
                id: navigationMenuPublicationItems.itemId,
                menuId: navigationMenuPublicationItems.menuId,
                parentId: navigationMenuPublicationItems.parentId,
                position: navigationMenuPublicationItems.position,
                label: navigationMenuPublicationItems.label,
                labelMode: navigationMenuPublicationItems.labelMode,
                targetType: navigationMenuPublicationItems.targetType,
                targetId: navigationMenuPublicationItems.targetId,
                targetValue: navigationMenuPublicationItems.targetValue,
                targetQuery: navigationMenuPublicationItems.targetQuery,
                openInNewTab: navigationMenuPublicationItems.openInNewTab,
                isEnabled: navigationMenuPublicationItems.isEnabled,
                createdAt: sql<number>`unixepoch()`.as("created_at"),
                updatedAt: sql<number>`unixepoch()`.as("updated_at"),
            }).from(navigationMenuPublicationItems).where(and(
                eq(navigationMenuPublicationItems.menuId, menuId),
                eq(navigationMenuPublicationItems.revision, input.sourceRevision),
            ))),
            db.insert(navigationMenuPublications).values({
                menuId,
                revision: publishedRevision,
                publishedBy: input.publishedBy ?? null,
                itemCount: sourcePublication.itemCount,
                checksum,
            }),
            db.insert(navigationMenuPublicationItems).select(db.select({
                menuId: navigationMenuPublicationItems.menuId,
                revision: sql<number>`${publishedRevision}`.as("revision"),
                itemId: navigationMenuPublicationItems.itemId,
                parentId: navigationMenuPublicationItems.parentId,
                position: navigationMenuPublicationItems.position,
                label: navigationMenuPublicationItems.label,
                labelMode: navigationMenuPublicationItems.labelMode,
                targetType: navigationMenuPublicationItems.targetType,
                targetId: navigationMenuPublicationItems.targetId,
                targetValue: navigationMenuPublicationItems.targetValue,
                targetQuery: navigationMenuPublicationItems.targetQuery,
                openInNewTab: navigationMenuPublicationItems.openInNewTab,
                isEnabled: navigationMenuPublicationItems.isEnabled,
            }).from(navigationMenuPublicationItems).where(and(
                eq(navigationMenuPublicationItems.menuId, menuId),
                eq(navigationMenuPublicationItems.revision, input.sourceRevision),
            ))),
            db.update(navigationMenus)
                .set({
                    revision: publishedRevision,
                    publishedRevision,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(navigationMenus.id, menuId),
                    eq(navigationMenus.revision, input.expectedRevision),
                ))
                .returning({ revision: navigationMenus.revision }),
        ] as never) as unknown[];
        return {
            revision: readRevisionResult(results.at(-1)),
            publishedRevision,
            sourceRevision: input.sourceRevision,
            itemCount: sourcePublication.itemCount,
            checksum,
        };
    } catch (error) {
        return rethrowNavigationMutationError(db, menuId, input.expectedRevision, error);
    }
}

function publishedHierarchyToTargets(
    nodes: readonly NavigationHierarchyNode<AuthorityProjectionRow>[],
): NavigationTargetItem[] {
    return nodes.flatMap((node) => {
        if (!node.item.isEnabled) return [];
        const item = authorityRowToTargetItem(node.item);
        const children = publishedHierarchyToTargets(node.children);
        return [{ ...item, ...(children.length ? { subMenu: children } : {}) }];
    });
}

export async function getPublishedNavigationMenuTree(
    db: Database,
    menuId: string,
    input: { maxItems?: number } = {},
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (menu.deletedAt || menu.publishedRevision == null) {
        throw new NotFoundError("Published menu not found.");
    }
    const publication = await db
        .select()
        .from(navigationMenuPublications)
        .where(and(
            eq(navigationMenuPublications.menuId, menuId),
            eq(navigationMenuPublications.revision, menu.publishedRevision),
        ))
        .get();
    if (!publication) throw new NavigationAuthorityUnavailableError();
    const maxItems = input.maxItems ?? NAVIGATION_MENU_ITEM_LIMIT;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > NAVIGATION_MENU_ITEM_LIMIT) {
        throw new ValidationError("Published menu read limit is invalid.");
    }
    if (publication.itemCount > maxItems) {
        throw new ConflictError(
            `This menu contains ${publication.itemCount} items, exceeding this placement's ${maxItems}-item rendering budget.`,
        );
    }
    const rows = await db
        .select()
        .from(navigationMenuPublicationItems)
        .where(and(
            eq(navigationMenuPublicationItems.menuId, menuId),
            eq(navigationMenuPublicationItems.revision, menu.publishedRevision),
        ))
        .orderBy(
            asc(navigationMenuPublicationItems.position),
            asc(navigationMenuPublicationItems.itemId),
        )
        .limit(maxItems + 1)
        .all();
    if (rows.length !== publication.itemCount) throw new NavigationAuthorityUnavailableError();
    const authorityRows: AuthorityProjectionRow[] = rows.map((row) => ({
        id: row.itemId,
        parentId: row.parentId,
        position: row.position,
        label: row.label,
        labelMode: row.labelMode,
        targetType: row.targetType,
        targetId: row.targetId,
        targetValue: row.targetValue,
        targetQuery: row.targetQuery,
        openInNewTab: row.openInNewTab,
        isEnabled: row.isEnabled,
    }));
    const targets = publishedHierarchyToTargets(buildNavigationHierarchy(authorityRows));
    const resources = await loadNavigationResourceSnapshots(db, { navigation: targets }, {});
    return {
        id: menu.id,
        name: menu.name,
        handle: menu.handle,
        publishedRevision: menu.publishedRevision,
        dependencyRevision: menu.dependencyRevision,
        checksum: publication.checksum,
        items: resolveNavigationItemsForPublic(targets, resources),
    };
}

/**
 * Resolve every storefront placement in one bounded projection. Placement
 * definitions currently cap the public surface at five menus and 150 items per
 * placement, but menu IDs are still chunked to respect D1's parameter limit if
 * the registry grows. Reused menus are loaded and resolved only once.
 */
export async function getPublishedNavigationPlacements(db: Database) {
    const placements = await getNavigationPlacementManifest(db);
    if (!placements.length) return [];

    const menuIds = [...new Set(placements.map((placement) => placement.menuId))];
    const rowsByMenu = new Map<string, AuthorityProjectionRow[]>();

    for (const chunk of chunkNavigationResourceIds(menuIds)) {
        const rows = await db
            .select({
                menuId: navigationMenuPublicationItems.menuId,
                id: navigationMenuPublicationItems.itemId,
                parentId: navigationMenuPublicationItems.parentId,
                position: navigationMenuPublicationItems.position,
                label: navigationMenuPublicationItems.label,
                labelMode: navigationMenuPublicationItems.labelMode,
                targetType: navigationMenuPublicationItems.targetType,
                targetId: navigationMenuPublicationItems.targetId,
                targetValue: navigationMenuPublicationItems.targetValue,
                targetQuery: navigationMenuPublicationItems.targetQuery,
                openInNewTab: navigationMenuPublicationItems.openInNewTab,
                isEnabled: navigationMenuPublicationItems.isEnabled,
            })
            .from(navigationMenuPublicationItems)
            .innerJoin(
                navigationMenus,
                and(
                    eq(navigationMenus.id, navigationMenuPublicationItems.menuId),
                    eq(navigationMenus.publishedRevision, navigationMenuPublicationItems.revision),
                ),
            )
            .where(inArray(navigationMenuPublicationItems.menuId, chunk))
            .orderBy(
                asc(navigationMenuPublicationItems.menuId),
                asc(navigationMenuPublicationItems.position),
                asc(navigationMenuPublicationItems.itemId),
            )
            .all();

        for (const row of rows) {
            const menuRows = rowsByMenu.get(row.menuId) ?? [];
            menuRows.push(row);
            rowsByMenu.set(row.menuId, menuRows);
        }
    }

    const targetsByMenu = new Map<string, NavigationTargetItem[]>();
    const validPlacements = [] as typeof placements;
    for (const placement of placements) {
        const rows = rowsByMenu.get(placement.menuId) ?? [];
        if (
            rows.length !== placement.itemCount
            || rows.length > placement.definition.maxItems
        ) {
            console.warn("[Navigation] Skipping an invalid public placement", {
                placementId: placement.id,
                menuId: placement.menuId,
            });
            continue;
        }
        validPlacements.push(placement);
        if (!targetsByMenu.has(placement.menuId)) {
            targetsByMenu.set(
                placement.menuId,
                publishedHierarchyToTargets(buildNavigationHierarchy(rows)),
            );
        }
    }

    const allTargets = [...targetsByMenu.values()].flat();
    const resources = await loadNavigationResourceSnapshots(
        db,
        { navigation: allTargets },
        {},
    );

    return validPlacements.map((placement) => ({
        ...placement,
        items: resolveNavigationItemsForPublic(
            targetsByMenu.get(placement.menuId) ?? [],
            resources,
        ),
    }));
}

export async function listPublishedNavigationMenuItems(
    db: Database,
    menuId: string,
    input: {
        parentId?: string | null;
        limit?: number;
        cursor?: NavigationItemCursor;
    } = {},
) {
    const menu = await getNavigationMenuAuthority(db, menuId);
    if (menu.deletedAt || menu.publishedRevision == null) {
        throw new NotFoundError("Published menu not found.");
    }
    const limit = normalizeLimit(input.limit);
    const parentId = input.parentId ?? null;
    const conditions = [
        eq(navigationMenuPublicationItems.menuId, menuId),
        eq(navigationMenuPublicationItems.revision, menu.publishedRevision),
        eq(navigationMenuPublicationItems.isEnabled, true),
        parentId == null
            ? isNull(navigationMenuPublicationItems.parentId)
            : eq(navigationMenuPublicationItems.parentId, parentId),
    ];
    if (input.cursor) {
        const cursorCondition = or(
            gt(navigationMenuPublicationItems.position, input.cursor.position),
            and(
                eq(navigationMenuPublicationItems.position, input.cursor.position),
                gt(navigationMenuPublicationItems.itemId, input.cursor.id),
            ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
    }
    const rows = await db
        .select({
            item: navigationMenuPublicationItems,
            childCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuPublicationItems} AS child
                WHERE child.menu_id = ${menuId}
                  AND child.revision = ${menu.publishedRevision}
                  AND child.parent_id = ${sql.raw("navigation_menu_publication_items.item_id")}
                  AND child.is_enabled = true
            )`,
        })
        .from(navigationMenuPublicationItems)
        .where(and(...conditions))
        .orderBy(
            asc(navigationMenuPublicationItems.position),
            asc(navigationMenuPublicationItems.itemId),
        )
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const targets = page.map(({ item }) => authorityRowToTargetItem({
        id: item.itemId,
        parentId: null,
        position: item.position,
        label: item.label,
        labelMode: item.labelMode,
        targetType: item.targetType,
        targetId: item.targetId,
        targetValue: item.targetValue,
        targetQuery: item.targetQuery,
        openInNewTab: item.openInNewTab,
        isEnabled: item.isEnabled,
    }));
    const resources = await loadNavigationResourceSnapshots(db, { navigation: targets }, {});
    const resolvedById = new Map(
        resolveNavigationItemsForPublic(targets, resources).map((item) => [item.id, item]),
    );
    const items = page.flatMap(({ item, childCount }) => {
        const resolved = resolvedById.get(item.itemId);
        return resolved ? [{ ...resolved, position: item.position, childCount }] : [];
    });
    const last = page.at(-1)?.item;
    return {
        menu: {
            id: menu.id,
            name: menu.name,
            handle: menu.handle,
            publishedRevision: menu.publishedRevision,
            dependencyRevision: menu.dependencyRevision,
        },
        parentId,
        items,
        nextCursor: hasMore && last
            ? { position: last.position, id: last.itemId }
            : null,
    };
}

export async function listNavigationPlacements(db: Database) {
    return db
        .select({
            placement: navigationPlacements,
            menuName: navigationMenus.name,
            menuDeletedAt: navigationMenus.deletedAt,
            publishedRevision: navigationMenus.publishedRevision,
            publicationItemCount: navigationMenuPublications.itemCount,
        })
        .from(navigationPlacements)
        .innerJoin(navigationMenus, eq(navigationMenus.id, navigationPlacements.menuId))
        .leftJoin(navigationMenuPublications, and(
            eq(navigationMenuPublications.menuId, navigationMenus.id),
            eq(navigationMenuPublications.revision, navigationMenus.publishedRevision),
        ))
        .orderBy(
            asc(navigationPlacements.surface),
            asc(navigationPlacements.slot),
            asc(navigationPlacements.position),
            asc(navigationPlacements.id),
        )
        .all();
}

export async function saveNavigationPlacement(
    db: Database,
    input: {
        id?: string;
        expectedRevision: number;
        surface: string;
        slot: string;
        position: number;
        menuId: string;
        labelOverride?: string | null;
        isEnabled?: boolean;
    },
) {
    const definition = getNavigationPlacementDefinition(input.surface, input.slot);
    if (!Number.isInteger(input.position) || input.position < 0 || input.position >= definition.maxPositions) {
        throw new ValidationError(`This navigation placement accepts positions 0–${definition.maxPositions - 1}.`);
    }
    if (!definition.repeatable && input.position !== 0) {
        throw new ValidationError("This navigation placement has one fixed position.");
    }
    const labelOverride = input.labelOverride?.trim() || null;
    if (labelOverride && labelOverride.length > 100) {
        throw new ValidationError("Placement labels must be 100 characters or fewer.");
    }
    const menu = await getNavigationMenuAuthority(db, input.menuId);
    if (menu.deletedAt || menu.publishedRevision == null) {
        throw new ValidationError("Publish this menu before assigning it to the storefront.");
    }
    const publication = await db
        .select({ itemCount: navigationMenuPublications.itemCount })
        .from(navigationMenuPublications)
        .where(and(
            eq(navigationMenuPublications.menuId, input.menuId),
            eq(navigationMenuPublications.revision, menu.publishedRevision),
        ))
        .get();
    if (!publication) throw new NavigationAuthorityUnavailableError();
    if (publication.itemCount > definition.maxItems) {
        throw new ValidationError(
            `This placement supports up to ${definition.maxItems} items; the published menu contains ${publication.itemCount}.`,
        );
    }

    const id = input.id?.trim() || `placement_${nanoid()}`;
    const existing = await db
        .select({ revision: navigationPlacements.revision })
        .from(navigationPlacements)
        .where(eq(navigationPlacements.id, id))
        .get();
    try {
        if (!existing) {
            if (input.expectedRevision !== 0) {
                throw new NavigationPlacementRevisionConflictError(id, input.expectedRevision, null);
            }
            const placement = await db
                .insert(navigationPlacements)
                .values({
                    id,
                    surface: definition.surface,
                    slot: definition.slot,
                    position: input.position,
                    menuId: input.menuId,
                    labelOverride,
                    isEnabled: input.isEnabled !== false,
                })
                .returning()
                .get();
            return { placement };
        }
        if (existing.revision !== input.expectedRevision) {
            throw new NavigationPlacementRevisionConflictError(id, input.expectedRevision, existing.revision);
        }
        const placement = await db
            .update(navigationPlacements)
            .set({
                surface: definition.surface,
                slot: definition.slot,
                position: input.position,
                menuId: input.menuId,
                labelOverride,
                isEnabled: input.isEnabled !== false,
                revision: sql`${navigationPlacements.revision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(navigationPlacements.id, id),
                eq(navigationPlacements.revision, input.expectedRevision),
            ))
            .returning()
            .get();
        if (!placement) {
            const current = await db
                .select({ revision: navigationPlacements.revision })
                .from(navigationPlacements)
                .where(eq(navigationPlacements.id, id))
                .get();
            throw new NavigationPlacementRevisionConflictError(
                id,
                input.expectedRevision,
                current?.revision ?? null,
            );
        }
        return { placement };
    } catch (error) {
        if (error instanceof NavigationPlacementRevisionConflictError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (/navigation_placements_active_slot_unique|UNIQUE constraint failed.*navigation_placements/i.test(message)) {
            throw new ConflictError("Another menu already occupies this storefront placement.");
        }
        throw error;
    }
}

export async function getNavigationPlacementManifest(db: Database) {
    const rows = await db
        .select({
            id: navigationPlacements.id,
            surface: navigationPlacements.surface,
            slot: navigationPlacements.slot,
            position: navigationPlacements.position,
            labelOverride: navigationPlacements.labelOverride,
            placementRevision: navigationPlacements.revision,
            menuId: navigationMenus.id,
            menuName: navigationMenus.name,
            publishedRevision: navigationMenus.publishedRevision,
            dependencyRevision: navigationMenus.dependencyRevision,
            itemCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuPublicationItems}
                WHERE ${navigationMenuPublicationItems.menuId} = ${sql.raw("navigation_menus.id")}
                  AND ${navigationMenuPublicationItems.revision} = ${sql.raw("navigation_menus.published_revision")}
            )`,
            rootCount: sql<number>`(
                SELECT COUNT(*) FROM ${navigationMenuPublicationItems}
                WHERE ${navigationMenuPublicationItems.menuId} = ${sql.raw("navigation_menus.id")}
                  AND ${navigationMenuPublicationItems.revision} = ${sql.raw("navigation_menus.published_revision")}
                  AND ${navigationMenuPublicationItems.parentId} IS NULL
                  AND ${navigationMenuPublicationItems.isEnabled} = true
            )`,
        })
        .from(navigationPlacements)
        .innerJoin(navigationMenus, eq(navigationMenus.id, navigationPlacements.menuId))
        .where(and(
            eq(navigationPlacements.isEnabled, true),
            isNull(navigationMenus.deletedAt),
            sql`${navigationMenus.publishedRevision} IS NOT NULL`,
        ))
        .orderBy(
            asc(navigationPlacements.surface),
            asc(navigationPlacements.slot),
            asc(navigationPlacements.position),
            asc(navigationPlacements.id),
        )
        .all();
    return rows.flatMap((row) => {
        try {
            return [{
                ...row,
                definition: getNavigationPlacementDefinition(row.surface, row.slot),
            }];
        } catch {
            console.warn("[Navigation] Skipping an unsupported public placement", {
                placementId: row.id,
            });
            return [];
        }
    });
}

interface ExpectedAuthorityItem {
    id: string;
    menuId: string;
    parentId: string | null;
    position: number;
    storage: NavigationMenuItemStorage;
}

function legacyItemStorage(item: NavigationTargetItem): NavigationMenuItemStorage {
    const label = item.customLabel?.trim() || item.lastKnownLabel?.trim() || "Untitled item";
    return normalizeNavigationMenuItemInput({
        label,
        labelMode: item.labelMode,
        target: item.target.type === "resource"
            ? {
                type: "resource",
                resourceType: item.target.resourceType,
                resourceId: item.target.resourceId,
                query: item.target.query,
            }
            : item.target,
    });
}

function flattenLegacyItems(
    menuId: string,
    items: readonly NavigationTargetItem[],
    parentSourceId: string | null = null,
): ExpectedAuthorityItem[] {
    return items.flatMap((item, index) => {
        const sourceId = item.id;
        const id = `${menuId}:${sourceId}`;
        const row: ExpectedAuthorityItem = {
            id,
            menuId,
            parentId: parentSourceId ? `${menuId}:${parentSourceId}` : null,
            position: (index + 1) * NAVIGATION_POSITION_GAP,
            storage: legacyItemStorage(item),
        };
        return [row, ...flattenLegacyItems(menuId, item.subMenu ?? [], sourceId)];
    });
}

function itemSignature(item: ExpectedAuthorityItem): string {
    return JSON.stringify({
        id: item.id,
        menuId: item.menuId,
        parentId: item.parentId,
        position: item.position,
        ...item.storage,
    });
}

export async function getNavigationAuthorityShadowReport(
    db: Database,
): Promise<NavigationAuthorityShadowReport> {
    const settings = await db
        .select({
            headerConfig: siteSettings.headerConfig,
            footerConfig: siteSettings.footerConfig,
        })
        .from(siteSettings)
        .where(eq(siteSettings.singletonKey, "default"))
        .get();
    const expectedMenus: Array<{ id: string; name: string; handle: string; items: NavigationTargetItem[] }> = [];
    if (settings) {
        const header = parseNavigationConfig("header", JSON.parse(settings.headerConfig));
        const footer = parseNavigationConfig("footer", JSON.parse(settings.footerConfig));
        const headerItems = Array.isArray(header.navigation)
            ? header.navigation as NavigationTargetItem[]
            : [];
        if (headerItems.length) {
            expectedMenus.push({
                id: "menu_legacy_header_primary",
                name: "Header primary",
                handle: "header-primary",
                items: headerItems,
            });
        }
        const footerMenus = Array.isArray(footer.menus) ? footer.menus : [];
        footerMenus.forEach((value, index) => {
            const menu = value as { title?: string; links?: NavigationTargetItem[] };
            expectedMenus.push({
                id: `menu_legacy_footer_${index}`,
                name: menu.title?.trim() || `Footer menu ${index + 1}`,
                handle: `footer-${index + 1}`,
                items: Array.isArray(menu.links) ? menu.links : [],
            });
        });
    }

    const [actualMenus, actualItems] = await db.batch([
        db.select({ id: navigationMenus.id, name: navigationMenus.name, handle: navigationMenus.handle })
            .from(navigationMenus)
            .where(isNull(navigationMenus.deletedAt))
            .orderBy(asc(navigationMenus.id)),
        db.select().from(navigationMenuItems).orderBy(asc(navigationMenuItems.id)),
    ]);
    const expectedItems = expectedMenus.flatMap((menu) => flattenLegacyItems(menu.id, menu.items));
    const actualItemSignatures = new Set(actualItems.map((item) => itemSignature({
        id: item.id,
        menuId: item.menuId,
        parentId: item.parentId,
        position: item.position,
        storage: {
            label: item.label,
            labelMode: item.labelMode,
            targetType: item.targetType,
            targetId: item.targetId,
            targetValue: item.targetValue,
            targetQuery: item.targetQuery,
            openInNewTab: item.openInNewTab,
            isEnabled: item.isEnabled,
        },
    })));
    const mismatches: string[] = [];
    const actualMenuById = new Map(actualMenus.map((menu) => [menu.id, menu]));
    for (const expected of expectedMenus) {
        const actual = actualMenuById.get(expected.id);
        if (!actual) mismatches.push(`missing_menu:${expected.id}`);
        else if (actual.name !== expected.name || actual.handle !== expected.handle) {
            mismatches.push(`menu_metadata:${expected.id}`);
        }
    }
    for (const expected of expectedItems) {
        if (!actualItemSignatures.has(itemSignature(expected))) {
            mismatches.push(`item:${expected.id}`);
            if (mismatches.length >= 50) break;
        }
    }
    if (actualMenus.length !== expectedMenus.length) mismatches.push("menu_count");
    if (actualItems.length !== expectedItems.length) mismatches.push("item_count");
    return {
        ready: mismatches.length === 0,
        legacyMenuCount: expectedMenus.length,
        authorityMenuCount: actualMenus.length,
        legacyItemCount: expectedItems.length,
        authorityItemCount: actualItems.length,
        mismatches,
    };
}

export class NavigationAuthorityUnavailableError extends AppError {
    constructor() {
        super(
            503,
            "NAVIGATION_AUTHORITY_UNAVAILABLE",
            "Navigation is still using the validated presentation bridge because normalized menu parity is not proven.",
        );
        this.name = "NavigationAuthorityUnavailableError";
    }
}
