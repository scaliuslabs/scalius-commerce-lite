// src/server/routes/admin/search.ts
// Admin OpenAPI routes for search.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";

import { ok } from "../../utils/api-response";
import { ServiceUnavailableError } from "../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ── Search ──

const searchRoute = createRoute({
    method: "get",
    path: "/",
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

// ── Reindex ──

const reindexRoute = createRoute({
    method: "post",
    path: "/reindex",
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
