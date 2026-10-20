// src/server/routes/admin/search.ts
// Admin OpenAPI routes for search.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/modules/catalog";

import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { ok } from "../../utils/api-response";
import { GLOBAL_SEARCH_KINDS, GLOBAL_SEARCH_LIMIT, globalSearch, type GlobalSearchKind } from "./global-search";
import { ServiceUnavailableError } from "../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { protectedField as pii } from "../../schemas/protected";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ── Search ──

const searchRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.search.get_search",
    tags: ["Admin - Search"],
    summary: "Search across products, pages, and categories",
    request: {
        query: z.object({
            q: z.string().optional().default("").openapi({ description: "Search query" }),
            categoryId: z.string().optional().openapi({ description: "Category ID filter" }),
            minPrice: z.string().optional().openapi({ description: "Minimum price" }),
            maxPrice: z.string().optional().openapi({ description: "Maximum price" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Max results" }),
            searchPages: z.string().optional().default("true").openapi({ description: "Include pages" }),
            searchCategories: z.string().optional().default("true").openapi({ description: "Include categories" })
        })
    },
    responses: {
        200: { description: "Search results", content: { "application/json": { schema: successEnvelope(z.object({ products: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), price: z.number() }).passthrough()), pages: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string() }).passthrough()), categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough()), query: z.string(), timestamp: z.string().optional() })) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(searchRoute, async (c) => {
    try {
        const query = c.req.valid("query");
        const q = query.q || "";
        const minPrice = query.minPrice ? parseFloat(query.minPrice) : undefined;
        const maxPrice = query.maxPrice ? parseFloat(query.maxPrice) : undefined;
        const searchPagesFlag = query.searchPages !== "false";
        const searchCategoriesFlag = query.searchCategories !== "false";

        if (!q.trim()) {
            return ok(c, {
                products: [],
                pages: [],
                categories: [],
                query: ""
            });
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Search timed out")), 5000);
        });

        const db = c.get("db");
        const searchPromise = search(db, q, {
            categoryId: query.categoryId,
            minPrice,
            maxPrice,
            limit: query.limit,
            searchPages: searchPagesFlag,
            searchCategories: searchCategoriesFlag
        });

        const results = await Promise.race([searchPromise, timeoutPromise]);

        return ok(c, {
            ...results,
            query: q,
            timestamp: new Date().toISOString()
        });
    } catch (error: unknown) {
        console.error("Search error:", error);
        if (error instanceof Error && error.message === "Search timed out") {
            throw new ServiceUnavailableError("Search timed out");
        }
        throw error;
    }
});

// ── Global search (the dashboard's ⌘K) ──

/** Each kind is searched only when the caller may read that kind's list. */
const KIND_LIST_PATHS: Record<GlobalSearchKind, string> = {
    orders: "/api/v1/admin/orders",
    customers: "/api/v1/admin/customers",
    products: "/api/v1/admin/products",
    discounts: "/api/v1/admin/discounts",
    collections: "/api/v1/admin/collections",
    categories: "/api/v1/admin/categories",
    pages: "/api/v1/admin/pages",
};

export function readableSearchKinds(permissions: ReadonlySet<string>): GlobalSearchKind[] {
    return GLOBAL_SEARCH_KINDS.filter((kind) => {
        const rule = getRoutePermission(KIND_LIST_PATHS[kind], "GET");
        if (!rule) return false;
        if (rule.allowAnyAdmin) return true;
        if (rule.permission) return permissions.has(rule.permission);
        if (rule.anyOf) return rule.anyOf.some((permission) => permissions.has(permission));
        if (rule.allOf) return rule.allOf.every((permission) => permissions.has(permission));
        return false;
    });
}

const globalSearchRoute = createRoute({
    method: "get",
    path: "/global",
    operationId: "dashboard.search.global",
    tags: ["Admin - Search"],
    summary: "Find a few orders, customers, products, discounts, collections, categories and pages for one term",
    request: {
        query: z.object({
            q: z.string().trim().max(100).openapi({ description: "What the staff member typed (2 characters or more)" }),
        }),
    },
    responses: {
        200: {
            description: `Up to ${GLOBAL_SEARCH_LIMIT} records of each kind the caller may read`,
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        query: z.string(),
                        orders: z.array(z.object({ id: z.string(), orderNumber: z.number().int().nullable(), customerName: pii("name", z.string()), status: z.string() })).max(GLOBAL_SEARCH_LIMIT),
                        customers: z.array(z.object({
                            id: z.string(),
                            name: pii("name", z.string()),
                            phone: pii("phone", z.string().nullable()),
                            email: pii("email", z.string().nullable()),
                            origin: z.string(),
                            latestOrderName: pii("name", z.string().nullable()),
                        })).max(GLOBAL_SEARCH_LIMIT),
                        products: z.array(z.object({ id: z.string(), name: z.string(), isActive: z.boolean(), matchedSku: z.string().nullable() })).max(GLOBAL_SEARCH_LIMIT),
                        discounts: z.array(z.object({ id: z.string(), name: z.string(), code: z.string().nullable(), status: z.string() })).max(GLOBAL_SEARCH_LIMIT),
                        collections: z.array(z.object({ id: z.string(), name: z.string() })).max(GLOBAL_SEARCH_LIMIT),
                        categories: z.array(z.object({ id: z.string(), name: z.string() })).max(GLOBAL_SEARCH_LIMIT),
                        pages: z.array(z.object({ id: z.string(), title: z.string(), contentType: z.string() })).max(GLOBAL_SEARCH_LIMIT),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(globalSearchRoute, async (c) => {
    const { q } = c.req.valid("query");
    const permissions: ReadonlySet<string> = c.get("adminPermissions") ?? new Set();
    const result = await globalSearch(c.get("db"), q, readableSearchKinds(permissions));
    return ok(c, { query: q, ...result });
});

// ── Reindex ──

const reindexRoute = createRoute({
    method: "post",
    path: "/reindex",
    operationId: "dashboard.search_reindex.reindex",
    tags: ["Admin - Search"],
    summary: "Trigger search reindex",
    responses: {
        200: { description: "Reindex initiated", content: { "application/json": { schema: messageResponse } } },
    }
});

app.openapi(reindexRoute, async (c) => {
    return ok(c, { message: "Reindex initiated" });
});

export { app as adminSearchRoutes };
