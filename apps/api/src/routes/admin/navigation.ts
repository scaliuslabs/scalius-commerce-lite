// src/server/routes/admin/navigation.ts
// Admin OpenAPI routes for navigation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getNavigationItems,
    getNavigationMenus,
    getNavigationPreviewProductCount,
    saveNavigationConfig,
    updateNavigationConfig,
    deleteNavigationConfig,
} from "@scalius/core/modules/navigation";
// OpenAPI-safe schema (no z.lazy() recursion — Hono spec generator stack overflows on recursive schemas)
const saveNavigationConfigSchema = z.object({
    type: z.enum(["header", "footer"]),
    config: z.record(z.string(), z.unknown()),
});
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getKv } from "../../utils/kv-cache";
import { invalidateApiAndScheduleStorefrontGroups } from "../../utils/cache-invalidation";

import { ok, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    messageResponse,
    noContentResponse,
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
                    })),
                },
            },
        },
        ...errorResponses,
    }
});

app.openapi(getConfigRoute, async (c) => {
    const db = c.get("db");
    const { headerConfig, footerConfig } = await getNavigationMenus(db);
    return ok(c, { headerConfig, footerConfig });
});

// ── Save Navigation Config (Create/Update) ──

const saveConfigRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Navigation"],
    summary: "Save navigation config (header or footer)",
    request: {
        body: { content: { "application/json": { schema: saveNavigationConfigSchema } } }
    },
    responses: {
        200: {
            description: "Navigation config saved",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(saveConfigRoute, async (c) => {
    const db = c.get("db");
    const { type, config } = c.req.valid("json");
    await saveNavigationConfig(db, type, config as Record<string, unknown>);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, { message: `${type} navigation config saved` });
});

// ── Update Navigation Config ──

const updateConfigRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Update navigation config by site settings ID",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: saveNavigationConfigSchema } } }
    },
    responses: {
        200: {
            description: "Navigation config updated",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(updateConfigRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { type, config } = c.req.valid("json");
    await updateNavigationConfig(db, id, type, config as Record<string, unknown>);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, { message: `${type} navigation config updated` });
});

// ── Delete Navigation Config ──

const deleteConfigRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Navigation"],
    summary: "Reset navigation config to empty",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        type: z.enum(["header", "footer"]),
                    })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteConfigRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { type } = c.req.valid("json");
    await deleteNavigationConfig(db, id, type);
    await invalidateSiteSettingsCache(getKv());
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return noContent(c);
});

export { app as adminNavigationRoutes };
