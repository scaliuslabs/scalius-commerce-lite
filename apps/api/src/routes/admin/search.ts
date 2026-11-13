// src/server/routes/admin/search.ts
// Admin OpenAPI routes for search: the dashboard's global search (⌘K).

import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import { getRoutePermission, routeRuleAllows } from "@scalius/core/auth/rbac/route-permissions";
import { ok } from "../../utils/api-response";
import { fts5FillProgress } from "@scalius/core/search";
import { GLOBAL_SEARCH_KINDS, GLOBAL_SEARCH_LIMIT, globalSearch, type GlobalSearchKind } from "./global-search";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import { protectedField as pii } from "../../schemas/protected";
const app = adminRouter();

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
        return rule !== null && routeRuleAllows(rule, permissions, { anyAdmin: true });
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
                        indexing: z.object({
                            orders: z.number().min(0).max(1).optional(),
                            pages: z.number().min(0).max(1).optional(),
                        }).openapi({ description: "Kinds whose search index is still being filled after an upgrade, with the share done (0 to 1): their name search may miss older records until it finishes. Empty once every index is complete." }),
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
    const kinds = readableSearchKinds(permissions);
    const db = c.get("db");
    const [result, progress] = await Promise.all([globalSearch(db, q, kinds), fts5FillProgress(db)]);
    const indexing = Object.fromEntries((["orders", "pages"] as const).filter((kind) => kinds.includes(kind) && progress[kind] !== undefined).map((kind) => [kind, progress[kind]!]));
    return ok(c, { query: q, ...result, indexing });
});

export { app as adminSearchRoutes };
