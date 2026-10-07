import { categories, collections, pages, products } from "@scalius/database/schema";
import { chunkForD1, type Database, safeBatch } from "@scalius/database/client";
import { inArray } from "drizzle-orm";
import {
    getNavigationItemLabel,
    parseNavigationQuery,
    type NavigationReadiness,
    type NavigationResolution,
    type NavigationResourceType,
    type NavigationTargetItem,
    type ResolvedNavigationItem,
} from "@scalius/shared/navigation-target";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { contentEntryPath } from "../pages";
import { deps } from "../../cache-deps";
import { translateRows, translationColumns, type TranslationScope } from "../translations";

export const NAVIGATION_RESOURCE_READ_CHUNK_SIZE = 90;

export interface NavigationResourceSnapshot {
    id: string;
    resourceType: NavigationResourceType;
    title: string;
    route: string;
    readiness: Extract<
        NavigationReadiness,
        "ready" | "resource_draft_or_internal" | "resource_trashed"
    >;
    /** Category photo for mega-menu panels; set only when non-empty. */
    imageUrl?: string;
}

export type NavigationResourceSnapshotMap = ReadonlyMap<
    string,
    NavigationResourceSnapshot
>;

function resourceKey(resourceType: NavigationResourceType, id: string): string {
    return `${resourceType}:${id}`;
}

export function chunkNavigationResourceIds(ids: readonly string[]): string[][] {
    return chunkForD1([...new Set(ids)], NAVIGATION_RESOURCE_READ_CHUNK_SIZE);
}

function collectResourceIds(
    items: readonly NavigationTargetItem[],
    result: Map<NavigationResourceType, Set<string>>,
): void {
    for (const item of items) {
        if (item.target.type === "resource") {
            result.get(item.target.resourceType)?.add(item.target.resourceId);
        }
        if (item.subMenu?.length) collectResourceIds(item.subMenu, result);
    }
}

function configItems(
    type: "header" | "footer",
    config: Record<string, unknown>,
): NavigationTargetItem[] {
    if (type === "header") {
        return Array.isArray(config.navigation)
            ? config.navigation as NavigationTargetItem[]
            : [];
    }
    const menus = Array.isArray(config.menus) ? config.menus : [];
    return menus.flatMap((value) => {
        const menu = value as { links?: unknown };
        return Array.isArray(menu.links) ? menu.links as NavigationTargetItem[] : [];
    });
}

type BatchItem = Parameters<typeof safeBatch>[1][number];

/** One chunked statement and how its rows become snapshots. */
interface ResourceReader {
    statement: BatchItem;
    snapshots(rows: unknown): NavigationResourceSnapshot[];
}

function pageReader(db: Database, ids: string[], translation: TranslationScope | null): ResourceReader {
    const statement = db.select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        contentType: pages.contentType,
        canonicalPath: pages.canonicalPath,
        isPublished: pages.isPublished,
        deletedAt: pages.deletedAt,
        ...translationColumns(translation, "page", pages.id),
    }).from(pages).where(inArray(pages.id, ids));
    return {
        statement,
        snapshots: (rows) => translateRows(translation, "page", rows as Awaited<typeof statement>, { title: "title" }).map((row) => ({
            id: row.id,
            resourceType: "page",
            title: row.title,
            route: normalizeResourceCanonicalPath(
                row.contentType,
                row.canonicalPath,
            ) ?? contentEntryPath(row.contentType, row.slug),
            readiness: row.deletedAt
                ? "resource_trashed"
                : row.isPublished
                    ? "ready"
                    : "resource_draft_or_internal",
        })),
    };
}

function categoryReader(db: Database, ids: string[], translation: TranslationScope | null): ResourceReader {
    const statement = db.select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        canonicalPath: categories.canonicalPath,
        imageUrl: categories.imageUrl,
        status: categories.status,
        deletedAt: categories.deletedAt,
        ...translationColumns(translation, "category", categories.id),
    }).from(categories).where(inArray(categories.id, ids));
    return {
        statement,
        snapshots: (rows) => translateRows(translation, "category", rows as Awaited<typeof statement>, { name: "name" }).map((row) => {
            const imageUrl = row.imageUrl?.trim();
            return {
                id: row.id,
                resourceType: "category",
                title: row.name,
                route: normalizeResourceCanonicalPath("category", row.canonicalPath)
                    ?? `/categories/${row.slug}`,
                readiness: row.deletedAt
                    ? "resource_trashed"
                    : row.status === "published"
                        ? "ready"
                        : "resource_draft_or_internal",
                ...(imageUrl ? { imageUrl } : {}),
            };
        }),
    };
}

function collectionReader(db: Database, ids: string[], translation: TranslationScope | null): ResourceReader {
    const statement = db.select({
        id: collections.id,
        name: collections.name,
        canonicalPath: collections.canonicalPath,
        isActive: collections.isActive,
        deletedAt: collections.deletedAt,
        ...translationColumns(translation, "collection", collections.id, { slug: false }),
    }).from(collections).where(inArray(collections.id, ids));
    return {
        statement,
        snapshots: (rows) => translateRows(translation, "collection", rows as Awaited<typeof statement>, { name: "name" }).map((row) => ({
            id: row.id,
            resourceType: "collection",
            title: row.name,
            route: normalizeResourceCanonicalPath("collection", row.canonicalPath)
                ?? `/collections/${row.id}`,
            readiness: row.deletedAt
                ? "resource_trashed"
                : row.isActive
                    ? "ready"
                    : "resource_draft_or_internal",
        })),
    };
}

function productReader(db: Database, ids: string[], translation: TranslationScope | null): ResourceReader {
    const statement = db.select({
        id: products.id,
        name: products.name,
        slug: products.slug,
        canonicalPath: products.canonicalPath,
        isActive: products.isActive,
        deletedAt: products.deletedAt,
        ...translationColumns(translation, "product", products.id),
    }).from(products).where(inArray(products.id, ids));
    return {
        statement,
        snapshots: (rows) => translateRows(translation, "product", rows as Awaited<typeof statement>, { name: "name" }).map((row) => ({
            id: row.id,
            resourceType: "product",
            title: row.name,
            route: normalizeResourceCanonicalPath("product", row.canonicalPath)
                ?? `/products/${row.slug}`,
            readiness: row.deletedAt
                ? "resource_trashed"
                : row.isActive
                    ? "ready"
                    : "resource_draft_or_internal",
        })),
    };
}

const RESOURCE_READERS: Record<NavigationResourceType, (db: Database, ids: string[], translation: TranslationScope | null) => ResourceReader> = {
    page: pageReader,
    category: categoryReader,
    collection: collectionReader,
    product: productReader,
};

/**
 * The statements that read every typed resource these items link to, each
 * binding at most 90 IDs, and how to turn their results into snapshots.
 * They go in one batch (one round trip; its statements run in order), so a
 * caller can send them together with its own reads.
 */
export function planNavigationResourceSnapshots(
    db: Database,
    items: readonly NavigationTargetItem[],
    /** A presence read's language: titles and handles in its translations (MARKETS-DESIGN D9). */
    translation: TranslationScope | null = null,
): {
    statements: BatchItem[];
    resolve(results: readonly unknown[], offset: number): Map<string, NavigationResourceSnapshot>;
} {
    const idsByType = new Map<NavigationResourceType, Set<string>>([
        ["page", new Set()],
        ["category", new Set()],
        ["collection", new Set()],
        ["product", new Set()],
    ]);
    collectResourceIds(items, idsByType);
    // Every target id asked for, found or not: a later create, rename,
    // publish or trash of that row advances its own key.
    deps.pages(idsByType.get("page") ?? []);
    deps.categories(idsByType.get("category") ?? []);
    deps.collections(idsByType.get("collection") ?? []);
    deps.products(idsByType.get("product") ?? []);

    const readers = [...idsByType].flatMap(([resourceType, ids]) => (
        chunkNavigationResourceIds([...ids]).map((chunk) => RESOURCE_READERS[resourceType](db, chunk, translation))
    ));
    return {
        statements: readers.map((reader) => reader.statement),
        resolve(results, offset) {
            const snapshots = new Map<string, NavigationResourceSnapshot>();
            readers.forEach((reader, index) => {
                for (const snapshot of reader.snapshots(results[offset + index])) {
                    snapshots.set(resourceKey(snapshot.resourceType, snapshot.id), snapshot);
                }
            });
            return snapshots;
        },
    };
}

/**
 * Load all typed resource targets for a header/footer pair in one batch
 * (every statement binds at most 90 IDs).
 */
export async function loadNavigationResourceSnapshots(
    db: Database,
    headerConfig: Record<string, unknown>,
    footerConfig: Record<string, unknown>,
): Promise<Map<string, NavigationResourceSnapshot>> {
    const plan = planNavigationResourceSnapshots(db, [
        ...configItems("header", headerConfig),
        ...configItems("footer", footerConfig),
    ]);
    const results = plan.statements.length > 0 ? await safeBatch(db, plan.statements) : [];
    return plan.resolve(results, 0);
}

function appendQuery(route: string, value: string | undefined): string {
    const query = parseNavigationQuery(value);
    return query.ok && query.query ? `${route}${query.query}` : route;
}

/** The photo of a category an item links to, for mega-menu panels. */
function categoryImageUrl(
    item: NavigationTargetItem,
    resources: NavigationResourceSnapshotMap,
): string | undefined {
    if (item.target.type !== "resource" || item.target.resourceType !== "category") {
        return undefined;
    }
    return resources.get(resourceKey("category", item.target.resourceId))?.imageUrl;
}

function resolveItem(
    item: NavigationTargetItem,
    resources: NavigationResourceSnapshotMap,
): NavigationResolution {
    if (item.target.type === "resource") {
        const resource = resources.get(resourceKey(
            item.target.resourceType,
            item.target.resourceId,
        ));
        const title = item.labelMode === "custom"
            ? item.customLabel ?? resource?.title ?? item.lastKnownLabel ?? "Unavailable item"
            : resource?.title ?? item.lastKnownLabel ?? item.customLabel ?? "Unavailable item";
        if (!resource) {
            return {
                title,
                readiness: "resource_missing",
                available: false,
            };
        }
        return {
            title,
            href: appendQuery(resource.route, item.target.query),
            readiness: resource.readiness,
            available: resource.readiness === "ready",
        };
    }

    const title = item.customLabel ?? item.lastKnownLabel ?? "Untitled item";
    if (item.target.type === "label") {
        return { title, readiness: "ready", available: true };
    }

    const rawValue = item.target.type === "internal_path"
        ? item.target.path
        : item.target.url;
    const parsed = parseNavigationHref(rawValue);
    const expectedKind = item.target.type === "internal_path" ? "internal" : "external";
    if (!parsed.ok || parsed.kind !== expectedKind || !parsed.href) {
        return {
            title,
            readiness: "invalid_custom_target",
            available: false,
        };
    }
    return {
        title,
        href: parsed.href,
        readiness: item.target.type === "internal_path"
            ? "unverified_internal_path"
            : "ready",
        available: true,
    };
}

export function resolveNavigationItemsForAdmin(
    items: readonly NavigationTargetItem[],
    resources: NavigationResourceSnapshotMap,
): NavigationTargetItem[] {
    return items.map((item) => ({
        ...item,
        resolution: resolveItem(item, resources),
        ...(item.subMenu?.length
            ? { subMenu: resolveNavigationItemsForAdmin(item.subMenu, resources) }
            : {}),
    }));
}

export function resolveNavigationItemsForPublic(
    items: readonly NavigationTargetItem[],
    resources: NavigationResourceSnapshotMap,
): ResolvedNavigationItem[] {
    const result: ResolvedNavigationItem[] = [];
    for (const item of items) {
        const children = resolveNavigationItemsForPublic(item.subMenu ?? [], resources);
        const resolution = resolveItem(item, resources);

        if (!resolution.available && children.length === 0) continue;
        if (!resolution.available) {
            result.push({
                id: item.id,
                title: resolution.title || getNavigationItemLabel(item),
                subMenu: children,
            });
            continue;
        }

        const imageUrl = categoryImageUrl(item, resources);
        result.push({
            id: item.id,
            title: resolution.title,
            ...(resolution.href ? { href: resolution.href } : {}),
            ...(imageUrl ? { imageUrl } : {}),
            ...(item.openInNewTab === true ? { openInNewTab: true } : {}),
            ...(children.length ? { subMenu: children } : {}),
        });
    }
    return result;
}

function projectConfig(
    type: "header" | "footer",
    config: Record<string, unknown>,
    resources: NavigationResourceSnapshotMap,
    audience: "admin" | "public",
): Record<string, unknown> {
    if (type === "header") {
        const navigation = configItems("header", config);
        return {
            ...config,
            navigation: audience === "admin"
                ? resolveNavigationItemsForAdmin(navigation, resources)
                : resolveNavigationItemsForPublic(navigation, resources),
        };
    }

    const menus = Array.isArray(config.menus) ? config.menus : [];
    return {
        ...config,
        menus: menus.map((value) => {
            const menu = value as Record<string, unknown> & { links?: NavigationTargetItem[] };
            const links = Array.isArray(menu.links) ? menu.links : [];
            return {
                ...menu,
                links: audience === "admin"
                    ? resolveNavigationItemsForAdmin(links, resources)
                    : resolveNavigationItemsForPublic(links, resources),
            };
        }),
    };
}

export async function resolveNavigationConfigs(
    db: Database,
    headerConfig: Record<string, unknown>,
    footerConfig: Record<string, unknown>,
    audience: "admin" | "public",
): Promise<{ headerConfig: Record<string, unknown>; footerConfig: Record<string, unknown> }> {
    const resources = await loadNavigationResourceSnapshots(db, headerConfig, footerConfig);
    return {
        headerConfig: projectConfig("header", headerConfig, resources, audience),
        footerConfig: projectConfig("footer", footerConfig, resources, audience),
    };
}
