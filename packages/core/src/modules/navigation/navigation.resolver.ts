import { categories, collections, pages, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
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
}

export type NavigationResourceSnapshotMap = ReadonlyMap<
    string,
    NavigationResourceSnapshot
>;

function resourceKey(resourceType: NavigationResourceType, id: string): string {
    return `${resourceType}:${id}`;
}

export function chunkNavigationResourceIds(ids: readonly string[]): string[][] {
    const uniqueIds = [...new Set(ids)];
    const chunks: string[][] = [];
    for (let index = 0; index < uniqueIds.length; index += NAVIGATION_RESOURCE_READ_CHUNK_SIZE) {
        chunks.push(uniqueIds.slice(index, index + NAVIGATION_RESOURCE_READ_CHUNK_SIZE));
    }
    return chunks;
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

/**
 * Load all typed resource targets for a header/footer pair. Each D1 statement
 * binds at most 90 IDs and every wave is awaited before the next starts.
 */
export async function loadNavigationResourceSnapshots(
    db: Database,
    headerConfig: Record<string, unknown>,
    footerConfig: Record<string, unknown>,
): Promise<Map<string, NavigationResourceSnapshot>> {
    const idsByType = new Map<NavigationResourceType, Set<string>>([
        ["page", new Set()],
        ["category", new Set()],
        ["collection", new Set()],
        ["product", new Set()],
    ]);
    collectResourceIds(configItems("header", headerConfig), idsByType);
    collectResourceIds(configItems("footer", footerConfig), idsByType);

    const snapshots = new Map<string, NavigationResourceSnapshot>();

    for (const ids of chunkNavigationResourceIds([...idsByType.get("page") ?? []])) {
        const rows = await db.select({
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
            isPublished: pages.isPublished,
            deletedAt: pages.deletedAt,
        }).from(pages).where(inArray(pages.id, ids));
        for (const row of rows) {
            snapshots.set(resourceKey("page", row.id), {
                id: row.id,
                resourceType: "page",
                title: row.title,
                // Page canonical aliases are not routed yet. Resolve only the live route.
                route: `/${row.slug}`,
                readiness: row.deletedAt
                    ? "resource_trashed"
                    : row.isPublished
                        ? "ready"
                        : "resource_draft_or_internal",
            });
        }
    }

    for (const ids of chunkNavigationResourceIds([...idsByType.get("category") ?? []])) {
        const rows = await db.select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
            status: categories.status,
            deletedAt: categories.deletedAt,
        }).from(categories).where(inArray(categories.id, ids));
        for (const row of rows) {
            snapshots.set(resourceKey("category", row.id), {
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
            });
        }
    }

    for (const ids of chunkNavigationResourceIds([...idsByType.get("collection") ?? []])) {
        const rows = await db.select({
            id: collections.id,
            name: collections.name,
            canonicalPath: collections.canonicalPath,
            isActive: collections.isActive,
            deletedAt: collections.deletedAt,
        }).from(collections).where(inArray(collections.id, ids));
        for (const row of rows) {
            snapshots.set(resourceKey("collection", row.id), {
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
            });
        }
    }

    for (const ids of chunkNavigationResourceIds([...idsByType.get("product") ?? []])) {
        const rows = await db.select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
            isActive: products.isActive,
            deletedAt: products.deletedAt,
        }).from(products).where(inArray(products.id, ids));
        for (const row of rows) {
            snapshots.set(resourceKey("product", row.id), {
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
            });
        }
    }

    return snapshots;
}

function appendQuery(route: string, value: string | undefined): string {
    const query = parseNavigationQuery(value);
    return query.ok && query.query ? `${route}${query.query}` : route;
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

        result.push({
            id: item.id,
            title: resolution.title,
            ...(resolution.href ? { href: resolution.href } : {}),
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
