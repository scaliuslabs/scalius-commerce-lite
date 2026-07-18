// src/server/routes/admin/navigation.ts
// Admin OpenAPI routes for navigation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getNavigationItems,
    getNavigationPreviewProductCount,
} from "@scalius/core/modules/navigation";
import {
    getGeneralSettings,
    saveFooterConfig,
    saveHeaderConfig,
} from "@scalius/core/modules/settings/site-settings.service";
// OpenAPI-safe schema (no z.lazy() recursion — Hono spec generator stack overflows on recursive schemas)
const saveNavigationConfigSchema = z.object({
    type: z.enum(["header", "footer"]),
    config: z.record(z.string(), z.unknown()),
    expectedRevision: z.number().int().nonnegative(),
});
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getKv } from "../../utils/kv-cache";
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

// ── Get Navigation Config ──

const getConfigRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Navigation"],
    summary: "Get header and footer navigation config",
    responses: {
        200: {
            description: "Navigation configuration",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        headerConfig: z.record(z.string(), z.unknown()),
                        footerConfig: z.record(z.string(), z.unknown()),
                        revisions: z.object({
                            header: z.number().int().nonnegative(),
                            footer: z.number().int().nonnegative(),
                        }),
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(getConfigRoute, async (c) => {
    const db = c.get("db");
    const { headerConfig, footerConfig, revisions } = await getGeneralSettings(db);
    return ok(c, { headerConfig, footerConfig, revisions });
});

// ── Save Navigation Config (Create/Update) ──

const saveConfigRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Navigation"],
    summary: "Deprecated compatibility save for header or footer navigation",
    deprecated: true,
    request: {
        body: { content: { "application/json": { schema: saveNavigationConfigSchema } } }
    },
    responses: {
        200: {
            description: "Navigation config saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: z.string(),
                        revision: z.number().int().positive(),
                    })),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(saveConfigRoute, async (c) => {
    const db = c.get("db");
    const { type, config, expectedRevision } = c.req.valid("json");
    const saved = type === "header"
        ? await saveHeaderConfig(db, config as Record<string, unknown>, expectedRevision)
        : await saveFooterConfig(db, config as Record<string, unknown>, expectedRevision);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, {
        message: `${type} navigation config saved`,
        revision: saved.revision,
    });
});

// ── Update Navigation Config ──

const updateConfigRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Deprecated compatibility update for header or footer navigation",
    deprecated: true,
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: saveNavigationConfigSchema } } }
    },
    responses: {
        200: {
            description: "Navigation config updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: z.string(),
                        revision: z.number().int().positive(),
                    })),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(updateConfigRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { type, config, expectedRevision } = c.req.valid("json");
    const saved = type === "header"
        ? await saveHeaderConfig(db, config as Record<string, unknown>, expectedRevision)
        : await saveFooterConfig(db, config as Record<string, unknown>, expectedRevision);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, {
        message: `${type} navigation config updated for ${id}`,
        revision: saved.revision,
    });
});

// ── Delete Navigation Config ──

const deleteConfigRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Deprecated compatibility reset for header or footer navigation",
    deprecated: true,
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        type: z.enum(["header", "footer"]),
                        expectedRevision: z.number().int().nonnegative(),
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Navigation config reset",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        revision: z.number().int().positive(),
                    })),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(deleteConfigRoute, async (c) => {
    const db = c.get("db");
    c.req.valid("param");
    const { type, expectedRevision } = c.req.valid("json");
    const saved = type === "header"
        ? await saveHeaderConfig(db, { navigation: [] }, expectedRevision)
        : await saveFooterConfig(db, { menus: [] }, expectedRevision);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, saved);
});

export { app as adminNavigationRoutes };
