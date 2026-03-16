// src/server/routes/admin/collections.ts
// Admin OpenAPI routes for collections.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listCollections,
    getCollectionById,
    createCollection,
    updateCollection,
    deleteCollection,
    bulkDeleteCollections,
    bulkActivateCollections,
    bulkDeactivateCollections,
    restoreCollections,
    reorderCollections,
    createCollectionSchema,
    updateCollectionSchema
} from "@scalius/core/modules/collections";
import { categories, products } from "@scalius/database/schema";
import { isNull } from "drizzle-orm";
import { NotFoundError, ApiError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono();

// ── Form Options (categories + products for collection form) ──

const formOptionsRoute = createRoute({
    method: "get",
    path: "/form-options",
    tags: ["Admin - Collections"],
    summary: "Get categories and products for collection form",
    responses: {
        200: { description: "Form options" }
    }
});

app.openapi(formOptionsRoute, async (c) => {
    const db = c.get("db");
    const [allCategories, allProducts] = await Promise.all([
        db.select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(isNull(categories.deletedAt)),
        db.select({ id: products.id, name: products.name, price: products.price })
            .from(products)
            .where(isNull(products.deletedAt)),
    ]);
    return ok(c, { categories: allCategories, products: allProducts });
});

// ── List Collections ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Collections"],
    summary: "List all collections",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("sortOrder").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Collection list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    const result = await listCollections(db, {
        page: q.page,
        limit: q.limit,
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: q.sort as "name" | "type" | "isActive" | "updatedAt" | "sortOrder" | undefined,
        order: q.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

// ── Create Collection ──

const createCollectionRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Collections"],
    summary: "Create a collection",
    request: {
        body: { content: { "application/json": { schema: createCollectionSchema } } }
    },
    responses: {
        201: { description: "Collection created"  }
    }
});

app.openapi(createCollectionRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const collection = await createCollection(db, data);
    return created(c, collection);
});

// ── Bulk Delete Collections ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Collections"],
    summary: "Bulk delete collections",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        collectionIds: z.array(z.string()),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: { description: "Collections deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { collectionIds, permanent } = c.req.valid("json");
    await bulkDeleteCollections(db, collectionIds, permanent);
    return noContent(c);
});

// ── Bulk Activate Collections ──

const bulkActivateRoute = createRoute({
    method: "post",
    path: "/bulk-activate",
    tags: ["Admin - Collections"],
    summary: "Bulk activate collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Collections activated" }
    }
});

app.openapi(bulkActivateRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkActivateCollections(db, ids);
    return noContent(c);
});

// ── Bulk Deactivate Collections ──

const bulkDeactivateRoute = createRoute({
    method: "post",
    path: "/bulk-deactivate",
    tags: ["Admin - Collections"],
    summary: "Bulk deactivate collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Collections deactivated" }
    }
});

app.openapi(bulkDeactivateRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkDeactivateCollections(db, ids);
    return noContent(c);
});

// ── Bulk Restore Collections ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Collections"],
    summary: "Bulk restore collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: {
        204: { description: "Collections restored" }
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await restoreCollections(db, ids);
    return noContent(c);
});

// ── Restore Collection ──

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Collections"],
    summary: "Restore a soft-deleted collection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Collection restored" }
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const collection = await getCollectionById(db, id);
    if (!collection) throw new NotFoundError("Collection not found");
    await restoreCollections(db, [id]);
    return ok(c, { message: "Collection restored" });
});

// ── Reorder Collections ──

const reorderRoute = createRoute({
    method: "post",
    path: "/reorder",
    tags: ["Admin - Collections"],
    summary: "Reorder collections",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        items: z.array(z.object({ id: z.string(), sortOrder: z.number() }))
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "Collections reordered"  }
    }
});

app.openapi(reorderRoute, async (c) => {
    const db = c.get("db");
    const { items } = c.req.valid("json");
    await reorderCollections(db, items);
    return ok(c, {});
});

// ── Get Collection By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Collections"],
    summary: "Get a collection by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Collection details"  }
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const collection = await getCollectionById(db, id);
    if (!collection) throw new NotFoundError("Collection not found");
    return ok(c, collection);
});

// ── Update Collection ──

const updateCollectionRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Collections"],
    summary: "Update a collection",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCollectionSchema } } }
    },
    responses: {
        200: { description: "Collection updated"  }
    }
});

app.openapi(updateCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await updateCollection(db, id, c.req.valid("json"));
    return ok(c, result);
});

// ── Delete Collection ──

const deleteCollectionRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Collections"],
    summary: "Soft-delete a collection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Collection deleted" }
    }
});

app.openapi(deleteCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await deleteCollection(db, id);
        return noContent(c);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});

// ── Permanent Delete Collection ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Collections"],
    summary: "Permanently delete a collection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Collection permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await bulkDeleteCollections(db, [id], true);
        return noContent(c);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});

export { app as adminCollectionRoutes };
