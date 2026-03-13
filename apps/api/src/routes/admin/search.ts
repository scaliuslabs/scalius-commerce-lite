// src/server/routes/admin/search.ts
// Admin OpenAPI routes for search.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/search";

const app = new OpenAPIHono();

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
            limit: z.coerce.number().default(10).openapi({ description: "Max results" }),
            searchPages: z.string().optional().default("true").openapi({ description: "Include pages" }),
            searchCategories: z.string().optional().default("true").openapi({ description: "Include categories" })
        })
    },
    responses: {
        200: { description: "Search results"  }
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
            return c.json({
                products: [],
                pages: [],
                categories: [],
                success: true,
                query: ""
            }, 200);
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Search timed out")), 5000);
        });

        const searchPromise = search(q, {
            categoryId: query.categoryId,
            minPrice,
            maxPrice,
            limit: query.limit,
            searchPages: searchPagesFlag,
            searchCategories: searchCategoriesFlag
        });

        const results: any = await Promise.race([searchPromise, timeoutPromise]);

        return c.json({
            ...results,
            success: true,
            query: q,
            timestamp: new Date().toISOString()
        }, 200);
    } catch (error: any) {
        console.error("Search error:", error);
        if (error.message === "Search timed out") {
            return c.json({ error: "Search timed out", success: false }, 504);
        }
        return c.json({ error: "Internal server error", success: false }, 500);
    }
});

// ── Reindex ──

const reindexRoute = createRoute({
    method: "post",
    path: "/reindex",
    tags: ["Admin - Search"],
    summary: "Trigger search reindex",
    responses: {
        200: { description: "Reindex initiated"  }
    }
});

app.openapi(reindexRoute, async (c) => {
    return c.json({ success: true, message: "Reindex initiated" }, 200);
});

export { app as adminSearchRoutes };
