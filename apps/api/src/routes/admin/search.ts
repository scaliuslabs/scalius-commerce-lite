// src/server/routes/admin/search.ts
// Admin OpenAPI routes for search: the dashboard's global search (⌘K).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { ok } from "../../utils/api-response";
import { GLOBAL_SEARCH_KINDS, GLOBAL_SEARCH_LIMIT, globalSearch, type GlobalSearchKind } from "./global-search";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import { protectedField as pii } from "../../schemas/protected";
const app = new OpenAPIHono<{ Bindings: Env }>();

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

export { app as adminSearchRoutes };
