// src/server/routes/admin/categories.ts
// Admin Hono routes for categories.
// All DB logic is delegated to src/modules/categories/categories.service.ts.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    bulkDeleteCategories,
    restoreCategories,
    permanentlyDeleteCategory,
    createCategorySchema,
    updateCategorySchema,
} from "@/modules/categories";

const app = new Hono<{ Bindings: Env }>();

// GET /admin/categories — paginated list with search/sort/filter
app.get("/", async (c) => {
    const db = c.get("db");
    const query = c.req.query();
    const result = await listCategories(db, {
        page: parseInt(query.page || "1"),
        limit: parseInt(query.limit || "10"),
        search: query.search || "",
        showTrashed: query.trashed === "true",
        sort: (query.sort as any) || "updatedAt",
        order: (query.order as any) || "desc",
    });
    return c.json(result);
});

// POST /admin/categories — create new category
app.post("/", zValidator("json", createCategorySchema), async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await createCategory(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// POST /admin/categories/bulk-delete
app.post("/bulk-delete", zValidator("json", z.object({ categoryIds: z.array(z.string()), permanent: z.boolean().default(false) })), async (c) => {
    const db = c.get("db");
    const { categoryIds, permanent } = c.req.valid("json");
    if (categoryIds.length === 0) return c.json({ error: "No category IDs provided" }, 400);
    try {
        await bulkDeleteCategories(db, categoryIds, permanent);
        return c.body(null, 204);
    } catch (error: any) {
        return c.json({ error: error.message, ...(error.affectedProducts ? { suggestion: error.suggestion, affectedProducts: error.affectedProducts } : {}) }, error.statusCode || 400);
    }
});

// POST /admin/categories/bulk-restore
app.post("/bulk-restore", zValidator("json", z.object({ categoryIds: z.array(z.string()) })), async (c) => {
    const db = c.get("db");
    const { categoryIds } = c.req.valid("json");
    if (categoryIds.length === 0) return c.json({ error: "No category IDs provided" }, 400);
    await restoreCategories(db, categoryIds);
    return c.body(null, 204);
});

// PUT /admin/categories/:id — update category
app.put("/:id", zValidator("json", updateCategorySchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    try {
        await updateCategory(db, id, data);
        return c.json({ success: true });
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// DELETE /admin/categories/:id — soft-delete category
app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    try {
        await deleteCategory(db, id);
        return c.body(null, 204);
    } catch (error: any) {
        return c.json({ error: error.message, ...(error.affectedProducts ? { suggestion: error.suggestion, affectedProducts: error.affectedProducts } : {}) }, error.statusCode || 400);
    }
});

// DELETE /admin/categories/:id/permanent — hard delete
app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    await permanentlyDeleteCategory(db, id);
    return c.body(null, 204);
});

// POST /admin/categories/:id/restore — restore soft-deleted category
app.post("/:id/restore", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    await restoreCategories(db, [id]);
    return c.json({ success: true });
});

export { app as adminCategoryRoutes };
