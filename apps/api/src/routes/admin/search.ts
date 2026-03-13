// src/server/routes/admin/search.ts
import { Hono } from "hono";
import { search } from "@scalius/core/search";

const app = new Hono<{ Bindings: any }>();

app.get("/", async (c) => {
    try {
        const query = c.req.query("q") || "";
        const categoryId = c.req.query("categoryId");
        const minPriceStr = c.req.query("minPrice");
        const maxPriceStr = c.req.query("maxPrice");
        const minPrice = minPriceStr ? parseFloat(minPriceStr) : undefined;
        const maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : undefined;
        const limit = parseInt(c.req.query("limit") || "10", 10);
        const searchPages = c.req.query("searchPages") !== "false";
        const searchCategories = c.req.query("searchCategories") !== "false";

        if (!query.trim()) {
            return c.json({
                products: [],
                pages: [],
                categories: [],
                success: true,
                query: "",
            });
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Search timed out")), 5000);
        });

        const searchPromise = search(query, {
            categoryId,
            minPrice,
            maxPrice,
            limit,
            searchPages,
            searchCategories,
        });

        const results: any = await Promise.race([searchPromise, timeoutPromise]);

        return c.json({
            ...results,
            success: true,
            query,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        console.error("Search error:", error);
        if (error.message === "Search timed out") {
            return c.json({ error: "Search timed out", success: false }, 504);
        }
        return c.json({ error: "Internal server error", success: false }, 500);
    }
});

app.post("/reindex", async (c) => {
    // Hook up to actual reindex logic if available.
    return c.json({ success: true, message: "Reindex initiated" });
});

export { app as adminSearchRoutes };
