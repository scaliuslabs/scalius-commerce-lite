// src/server/routes/admin/navigation.ts
// Admin OpenAPI routes for navigation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    createNavigationMenu,
    createNavigationMenuItem,
    deleteNavigationMenuItem,
    getNavigationAuthorityShadowReport,
    getNavigationMenuItemAuthority,
    getNavigationMenuAuthority,
    getNavigationPlacementManifest,
    getNavigationItems,
    getNavigationPreviewProductCount,
    listNavigationMenuItems,
    listNavigationMenuPublications,
    listNavigationMenus,
    listNavigationPlacements,
    moveNavigationMenuItem,
    publishNavigationMenu,
    rollbackNavigationMenu,
    saveNavigationPlacement,
    searchNavigationMenuItems,
    updateNavigationMenuItem,
    updateNavigationMenuMetadata,
} from "@scalius/core/modules/navigation";
import { ValidationError } from "@scalius/core/errors";
import { invalidateApiAndScheduleStorefrontGroups } from "../../utils/cache-invalidation";

import { ok } from "../../utils/api-response";
import {
    successEnvelope,
    conflictResponse,
    errorResponses,
} from "../../schemas/responses";

// Navigation items returned by getNavigationItems service
const navSourceItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    type: z.string(),
    url: z.string(),
});

const previewProductsQuerySchema = z
    .object({
        categoryId: z.string().min(1),
        search: z.string().optional(),
        minPrice: z.coerce.number().optional(),
        maxPrice: z.coerce.number().optional(),
        freeDelivery: z.enum(["true", "false"]).optional(),
        hasDiscount: z.enum(["true", "false"]).optional(),
    })
    .catchall(z.string().optional());

const RESERVED_PREVIEW_QUERY_KEYS = new Set([
    "categoryId",
    "search",
    "minPrice",
    "maxPrice",
    "freeDelivery",
    "hasDiscount",
    "page",
    "limit",
    "sort",
    "sortBy",
    "order",
]);

const app = new OpenAPIHono<{ Bindings: Env }>();
const LAYOUT_CACHE_GROUPS = ["layout"] as const;

const menuTargetSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("resource"),
        resourceType: z.enum(["page", "category", "collection", "product"]),
        resourceId: z.string().trim().min(1).max(200),
        query: z.string().max(1024).optional(),
    }),
    z.object({
        type: z.literal("system"),
        key: z.enum(["home", "catalog", "search", "account", "cart", "checkout", "order_lookup"]),
    }),
    z.object({ type: z.literal("internal_path"), path: z.string().trim().min(1).max(2048) }),
    z.object({ type: z.literal("external_url"), url: z.string().trim().min(1).max(2048) }),
    z.object({ type: z.literal("label") }),
]);

const menuItemFieldsSchema = z.object({
    label: z.string().trim().min(1).max(100),
    labelMode: z.enum(["custom", "resource"]),
    target: menuTargetSchema,
    openInNewTab: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
});

const flatMenuItemSchema = z.object({
    id: z.string(),
    menuId: z.string(),
    parentId: z.string().nullable(),
    position: z.number().int(),
    label: z.string(),
    labelMode: z.enum(["custom", "resource"]),
    targetType: z.string(),
    targetId: z.string().nullable(),
    targetValue: z.string().nullable(),
    targetQuery: z.string().nullable(),
    openInNewTab: z.boolean(),
    isEnabled: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
});

function encodeCursor(value: Record<string, unknown> | null): string | null {
    if (!value) return null;
    return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor<T>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    try {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return JSON.parse(atob(padded)) as T;
    } catch {
        throw new ValidationError("Invalid navigation cursor.");
    }
}

// ── List Navigation Items ──

const listItemsRoute = createRoute({
    method: "get",
    path: "/items",
    tags: ["Admin - Navigation"],
    summary: "Get navigation items",
    responses: {
        200: {
            description: "Navigation items list",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        items: z.object({
                            categories: z.array(navSourceItemSchema),
                            pages: z.array(navSourceItemSchema),
                            products: z.array(navSourceItemSchema),
                            collections: z.array(navSourceItemSchema),
                        }),
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(listItemsRoute, async (c) => {
    const db = c.get("db");
    const items = await getNavigationItems(db);
    return ok(c, { items });
});

// ── Preview Dynamic Navigation Product Count ──

const previewProductsRoute = createRoute({
    method: "get",
    path: "/preview-products",
    tags: ["Admin - Navigation"],
    summary: "Preview dynamic navigation product count",
    request: {
        query: previewProductsQuerySchema,
    },
    responses: {
        200: {
            description: "Matching product count",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        count: z.number(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(previewProductsRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query") as Record<string, string | number | undefined> & {
        categoryId: string;
        search?: string;
        minPrice?: number;
        maxPrice?: number;
        freeDelivery?: "true" | "false";
        hasDiscount?: "true" | "false";
    };
    const {
        categoryId,
        search,
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        ...rawFilters
    } = query;
    const attributeFilters = Object.entries(rawFilters)
        .filter(([key, value]) => (
            !RESERVED_PREVIEW_QUERY_KEYS.has(key)
            && typeof value === "string"
            && value.trim().length > 0
        ))
        .map(([slug, value]) => ({ slug, value: value as string }));

    const result = await getNavigationPreviewProductCount(db, {
        categoryId,
        search,
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        attributeFilters,
    });

    return ok(c, result);
});

// ── Normalized Named Menus ──

const listMenusRoute = createRoute({
    method: "get",
    path: "/menus",
    tags: ["Admin - Navigation"],
    summary: "List reusable navigation menus",
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().optional(),
            includeTrash: z.enum(["true", "false"]).optional(),
        }),
    },
    responses: {
        200: {
            description: "Reusable navigation menus",
            content: { "application/json": { schema: successEnvelope(z.object({
                items: z.array(z.object({
                    id: z.string(),
                    name: z.string(),
                    handle: z.string(),
                    revision: z.number().int().positive(),
                    publishedRevision: z.number().int().positive().nullable(),
                    dependencyRevision: z.number().int().positive(),
                    updatedAt: z.coerce.date(),
                    deletedAt: z.coerce.date().nullable(),
                    itemCount: z.number().int().nonnegative(),
                    placementCount: z.number().int().nonnegative(),
                })),
                nextCursor: z.string().nullable(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listMenusRoute, async (c) => {
    const query = c.req.valid("query");
    const cursor = decodeCursor<{ updatedAt: number; id: string }>(query.cursor);
    const result = await listNavigationMenus(c.get("db"), {
        limit: query.limit,
        includeTrash: query.includeTrash === "true",
        cursor: cursor
            ? { updatedAt: new Date(cursor.updatedAt), id: cursor.id }
            : undefined,
    });
    return ok(c, {
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor
            ? { updatedAt: result.nextCursor.updatedAt.getTime(), id: result.nextCursor.id }
            : null),
    });
});

const createMenuRoute = createRoute({
    method: "post",
    path: "/menus",
    tags: ["Admin - Navigation"],
    summary: "Create a reusable navigation menu",
    request: {
        body: { content: { "application/json": { schema: z.object({
            name: z.string().trim().min(1).max(100),
            handle: z.string().trim().max(80).optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "Navigation menu created",
            content: { "application/json": { schema: successEnvelope(z.object({
                menu: z.record(z.string(), z.unknown()),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(createMenuRoute, async (c) => {
    const menu = await createNavigationMenu(c.get("db"), c.req.valid("json"));
    return ok(c, { menu });
});

const getMenuRoute = createRoute({
    method: "get",
    path: "/menus/{menuId}",
    tags: ["Admin - Navigation"],
    summary: "Get one reusable navigation menu",
    request: { params: z.object({ menuId: z.string().min(1) }) },
    responses: {
        200: {
            description: "Navigation menu",
            content: { "application/json": { schema: successEnvelope(z.object({
                menu: z.record(z.string(), z.unknown()),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(getMenuRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    return ok(c, { menu: await getNavigationMenuAuthority(c.get("db"), menuId) });
});

const updateMenuRoute = createRoute({
    method: "patch",
    path: "/menus/{menuId}",
    tags: ["Admin - Navigation"],
    summary: "Update menu identity with revision protection",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().positive(),
            name: z.string().trim().min(1).max(100),
            handle: z.string().trim().min(1).max(80),
        }) } } },
    },
    responses: {
        200: {
            description: "Navigation menu updated",
            content: { "application/json": { schema: successEnvelope(z.object({
                revision: z.number().int().positive(),
                name: z.string(),
                handle: z.string(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(updateMenuRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    return ok(c, await updateNavigationMenuMetadata(c.get("db"), menuId, c.req.valid("json")));
});

const listMenuItemsRoute = createRoute({
    method: "get",
    path: "/menus/{menuId}/items",
    tags: ["Admin - Navigation"],
    summary: "List one parent page of menu items",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        query: z.object({
            parentId: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().optional(),
        }),
    },
    responses: {
        200: {
            description: "Paged menu items",
            content: { "application/json": { schema: successEnvelope(z.object({
                items: z.array(z.object({
                    item: flatMenuItemSchema,
                    childCount: z.number().int().nonnegative(),
                })),
                nextCursor: z.string().nullable(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listMenuItemsRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    const query = c.req.valid("query");
    const cursor = decodeCursor<{ position: number; id: string }>(query.cursor);
    const result = await listNavigationMenuItems(c.get("db"), menuId, {
        parentId: query.parentId || null,
        limit: query.limit,
        cursor,
    });
    return ok(c, {
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor),
    });
});

const searchMenuItemsRoute = createRoute({
    method: "get",
    path: "/menus/{menuId}/search",
    tags: ["Admin - Navigation"],
    summary: "Search a large menu and include its ancestors",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        query: z.object({
            q: z.string().trim().min(2).max(100),
            limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
    },
    responses: {
        200: {
            description: "Matching menu items with ancestor context",
            content: { "application/json": { schema: successEnvelope(z.object({
                items: z.array(z.object({
                    item: flatMenuItemSchema,
                    childCount: z.number().int().nonnegative(),
                    isMatch: z.boolean(),
                })),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(searchMenuItemsRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    const query = c.req.valid("query");
    return ok(c, await searchNavigationMenuItems(c.get("db"), menuId, {
        query: query.q,
        limit: query.limit,
    }));
});

const getMenuItemRoute = createRoute({
    method: "get",
    path: "/menus/{menuId}/items/{itemId}",
    tags: ["Admin - Navigation"],
    summary: "Get one menu item",
    request: {
        params: z.object({ menuId: z.string().min(1), itemId: z.string().min(1) }),
    },
    responses: {
        200: {
            description: "Menu item",
            content: { "application/json": { schema: successEnvelope(z.object({
                item: flatMenuItemSchema,
                childCount: z.number().int().nonnegative(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(getMenuItemRoute, async (c) => {
    const { menuId, itemId } = c.req.valid("param");
    return ok(c, await getNavigationMenuItemAuthority(c.get("db"), menuId, itemId));
});

const createMenuItemRoute = createRoute({
    method: "post",
    path: "/menus/{menuId}/items",
    tags: ["Admin - Navigation"],
    summary: "Add one menu item",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        body: { content: { "application/json": { schema: menuItemFieldsSchema.extend({
            expectedRevision: z.number().int().positive(),
            parentId: z.string().nullable().optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu item created",
            content: { "application/json": { schema: successEnvelope(z.object({
                item: z.unknown(),
                revision: z.number().int().positive(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(createMenuItemRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    return ok(c, await createNavigationMenuItem(c.get("db"), menuId, c.req.valid("json")));
});

const updateMenuItemRoute = createRoute({
    method: "patch",
    path: "/menus/{menuId}/items/{itemId}",
    tags: ["Admin - Navigation"],
    summary: "Update one menu item",
    request: {
        params: z.object({ menuId: z.string().min(1), itemId: z.string().min(1) }),
        body: { content: { "application/json": { schema: menuItemFieldsSchema.extend({
            expectedRevision: z.number().int().positive(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu item updated",
            content: { "application/json": { schema: successEnvelope(z.object({
                item: z.unknown(),
                revision: z.number().int().positive(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(updateMenuItemRoute, async (c) => {
    const { menuId, itemId } = c.req.valid("param");
    return ok(c, await updateNavigationMenuItem(c.get("db"), menuId, itemId, c.req.valid("json")));
});

const moveMenuItemRoute = createRoute({
    method: "post",
    path: "/menus/{menuId}/items/{itemId}/move",
    tags: ["Admin - Navigation"],
    summary: "Move one menu item by stable destination identity",
    request: {
        params: z.object({ menuId: z.string().min(1), itemId: z.string().min(1) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().positive(),
            parentId: z.string().nullable().optional(),
            beforeId: z.string().optional(),
            afterId: z.string().optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu item moved",
            content: { "application/json": { schema: successEnvelope(z.object({
                revision: z.number().int().positive(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(moveMenuItemRoute, async (c) => {
    const { menuId, itemId } = c.req.valid("param");
    return ok(c, await moveNavigationMenuItem(c.get("db"), menuId, itemId, c.req.valid("json")));
});

const deleteMenuItemRoute = createRoute({
    method: "delete",
    path: "/menus/{menuId}/items/{itemId}",
    tags: ["Admin - Navigation"],
    summary: "Delete one menu item subtree",
    request: {
        params: z.object({ menuId: z.string().min(1), itemId: z.string().min(1) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().positive(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu item subtree deleted",
            content: { "application/json": { schema: successEnvelope(z.object({
                deletedCount: z.number().int().positive(),
                revision: z.number().int().positive(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(deleteMenuItemRoute, async (c) => {
    const { menuId, itemId } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    return ok(c, await deleteNavigationMenuItem(c.get("db"), menuId, itemId, expectedRevision));
});

const publishMenuRoute = createRoute({
    method: "post",
    path: "/menus/{menuId}/publish",
    tags: ["Admin - Navigation"],
    summary: "Publish an immutable menu revision",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().positive(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu published",
            content: { "application/json": { schema: successEnvelope(z.object({
                revision: z.number().int().positive(),
                publishedRevision: z.number().int().positive(),
                itemCount: z.number().int().nonnegative(),
                checksum: z.string(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(publishMenuRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    const user = c.get("user") as { id?: string } | undefined;
    const result = await publishNavigationMenu(c.get("db"), menuId, {
        ...c.req.valid("json"),
        publishedBy: user?.id ?? null,
    });
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, result);
});

const listMenuPublicationsRoute = createRoute({
    method: "get",
    path: "/menus/{menuId}/publications",
    tags: ["Admin - Navigation"],
    summary: "List immutable menu publications",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.coerce.number().int().positive().optional(),
        }),
    },
    responses: {
        200: {
            description: "Published menu history",
            content: { "application/json": { schema: successEnvelope(z.object({
                items: z.array(z.object({
                    menuId: z.string(),
                    revision: z.number().int().positive(),
                    publishedAt: z.coerce.date(),
                    publishedBy: z.string().nullable(),
                    itemCount: z.number().int().nonnegative(),
                    checksum: z.string(),
                })),
                nextCursor: z.number().int().positive().nullable(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listMenuPublicationsRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    const query = c.req.valid("query");
    return ok(c, await listNavigationMenuPublications(c.get("db"), menuId, {
        limit: query.limit,
        beforeRevision: query.cursor,
    }));
});

const rollbackMenuRoute = createRoute({
    method: "post",
    path: "/menus/{menuId}/rollback",
    tags: ["Admin - Navigation"],
    summary: "Restore a publication as a new immutable menu revision",
    request: {
        params: z.object({ menuId: z.string().min(1) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().positive(),
            sourceRevision: z.number().int().positive(),
        }) } } },
    },
    responses: {
        200: {
            description: "Menu revision restored and republished",
            content: { "application/json": { schema: successEnvelope(z.object({
                revision: z.number().int().positive(),
                publishedRevision: z.number().int().positive(),
                sourceRevision: z.number().int().positive(),
                itemCount: z.number().int().nonnegative(),
                checksum: z.string(),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(rollbackMenuRoute, async (c) => {
    const { menuId } = c.req.valid("param");
    const user = c.get("user") as { id?: string } | undefined;
    const result = await rollbackNavigationMenu(c.get("db"), menuId, {
        ...c.req.valid("json"),
        publishedBy: user?.id ?? null,
    });
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, result);
});

const placementManifestRoute = createRoute({
    method: "get",
    path: "/placements",
    tags: ["Admin - Navigation"],
    summary: "Get current navigation placement manifest",
    responses: {
        200: {
            description: "Navigation placements",
            content: { "application/json": { schema: successEnvelope(z.object({
                placements: z.array(z.record(z.string(), z.unknown())),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(placementManifestRoute, async (c) => {
    return ok(c, { placements: await getNavigationPlacementManifest(c.get("db")) });
});

const listPlacementSettingsRoute = createRoute({
    method: "get",
    path: "/placement-settings",
    tags: ["Admin - Navigation"],
    summary: "List navigation placement settings",
    responses: {
        200: {
            description: "Navigation placement settings",
            content: { "application/json": { schema: successEnvelope(z.object({
                placements: z.array(z.record(z.string(), z.unknown())),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listPlacementSettingsRoute, async (c) => {
    return ok(c, { placements: await listNavigationPlacements(c.get("db")) });
});

const savePlacementRoute = createRoute({
    method: "put",
    path: "/placements/{placementId}",
    tags: ["Admin - Navigation"],
    summary: "Create or update one navigation placement with CAS",
    request: {
        params: z.object({ placementId: z.string().trim().min(1).max(160) }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().nonnegative(),
            surface: z.string().trim().min(1).max(80),
            slot: z.string().trim().min(1).max(80),
            position: z.number().int().nonnegative(),
            menuId: z.string().trim().min(1).max(200),
            labelOverride: z.string().trim().max(100).nullable().optional(),
            isEnabled: z.boolean().optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "Navigation placement saved",
            content: { "application/json": { schema: successEnvelope(z.object({
                placement: z.record(z.string(), z.unknown()),
            })) } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(savePlacementRoute, async (c) => {
    const { placementId } = c.req.valid("param");
    const result = await saveNavigationPlacement(c.get("db"), {
        id: placementId,
        ...c.req.valid("json"),
    });
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, result);
});

const shadowReportRoute = createRoute({
    method: "get",
    path: "/authority-shadow",
    tags: ["Admin - Navigation"],
    summary: "Compare the normalized navigation authority with the typed bridge",
    responses: {
        200: {
            description: "Navigation migration parity",
            content: { "application/json": { schema: successEnvelope(z.object({
                ready: z.boolean(),
                legacyMenuCount: z.number().int().nonnegative(),
                authorityMenuCount: z.number().int().nonnegative(),
                legacyItemCount: z.number().int().nonnegative(),
                authorityItemCount: z.number().int().nonnegative(),
                mismatches: z.array(z.string()),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(shadowReportRoute, async (c) => {
    return ok(c, await getNavigationAuthorityShadowReport(c.get("db")));
});

export { app as adminNavigationRoutes };
