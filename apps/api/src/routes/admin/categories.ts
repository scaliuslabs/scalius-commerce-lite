// src/server/routes/admin/categories.ts
// Admin OpenAPI routes for categories.
// All DB logic is delegated to src/modules/categories/categories.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok, created, noContent } from "../../utils/api-response";
import {
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    bulkDeleteCategories,
    restoreCategories,
    permanentlyDeleteCategory,
    createCategorySchema,
    updateCategorySchema
} from "@scalius/core/modules/categories";

const app = new OpenAPIHono();

// ── List Categories ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Categories"],
    summary: "List all categories",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Category list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listCategories(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        showTrashed: query.trashed === "true",
        sort: (query.sort || "updatedAt") as string,
        order: (query.order || "desc") as string
    });
    return ok(c, result);
});

// ── Create Category ──

const createCategoryRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Categories"],
    summary: "Create a category",
    request: {
        body: { content: { "application/json": { schema: createCategorySchema } } }
    },
    responses: {
        201: { description: "Category created"  }
    }
});

app.openapi(createCategoryRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await createCategory(db, data);
        return created(c, result);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number; suggestion?: string; affectedProducts?: unknown };
        return c.json({ error: err.message || "Unknown error" }, err.statusCode || 400);
    }
});

// ── Bulk Delete Categories ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Categories"],
    summary: "Bulk delete categories",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        categoryIds: z.array(z.string()),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: { description: "Categories deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { categoryIds, permanent } = c.req.valid("json");
    if (categoryIds.length === 0) return c.json({ error: "No category IDs provided" }, 400);
    try {
        await bulkDeleteCategories(db, categoryIds, permanent);
        return noContent(c);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number; suggestion?: string; affectedProducts?: unknown };
        return c.json({ error: err.message || "Unknown error", ...(err.affectedProducts ? { suggestion: err.suggestion, affectedProducts: err.affectedProducts } : {}) }, err.statusCode || 400);
    }
});

// ── Bulk Restore Categories ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Categories"],
    summary: "Bulk restore categories",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ categoryIds: z.array(z.string()) })
                }
            }
        }
    },
    responses: {
        204: { description: "Categories restored" }
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { categoryIds } = c.req.valid("json");
    if (categoryIds.length === 0) return c.json({ error: "No category IDs provided" }, 400);
    await restoreCategories(db, categoryIds);
    return noContent(c);
});

// ── Update Category ──

const updateCategoryRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Categories"],
    summary: "Update a category",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCategorySchema } } }
    },
    responses: {
        200: { description: "Category updated"  }
    }
});

app.openapi(updateCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        await updateCategory(db, id, data);
        return ok(c, {});
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number; suggestion?: string; affectedProducts?: unknown };
        return c.json({ error: err.message || "Unknown error" }, err.statusCode || 400);
    }
});

// ── Delete Category ──

const deleteCategoryRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Categories"],
    summary: "Soft-delete a category",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Category deleted" }
    }
});

app.openapi(deleteCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await deleteCategory(db, id);
        return noContent(c);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number; suggestion?: string; affectedProducts?: unknown };
        return c.json({ error: err.message || "Unknown error", ...(err.affectedProducts ? { suggestion: err.suggestion, affectedProducts: err.affectedProducts } : {}) }, err.statusCode || 400);
    }
});

// ── Permanent Delete Category ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Categories"],
    summary: "Permanently delete a category",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Category permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteCategory(db, id);
    return noContent(c);
});

// ── Restore Category ──

const restoreCategoryRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Categories"],
    summary: "Restore a soft-deleted category",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Category restored"  }
    }
});

app.openapi(restoreCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreCategories(db, [id]);
    return ok(c, {});
});

export { app as adminCategoryRoutes };
