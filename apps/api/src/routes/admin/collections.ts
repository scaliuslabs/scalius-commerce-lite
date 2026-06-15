// src/server/routes/admin/collections.ts
// Admin OpenAPI routes for collections.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listCollections,
    getCollectionById,
    getCollectionCategoryOptions,
    getCollectionsByIds,
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
import { NotFoundError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    messageResponse,
    noContentResponse,
} from "../../schemas/responses";
import { collectionSchema } from "../../schemas/entities";
import { invalidateCatalogCaches } from "../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();

const collectionOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
});

const collectionPickerSummarySchema = collectionOptionSchema.extend({
    type: z.enum(["manual", "dynamic"]),
});

function parseLookupIds(ids: string | undefined): string[] {
    return Array.from(new Set((ids ?? "").split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

// ── Form Options (categories + products for collection form) ──

const formOptionsRoute = createRoute({
    method: "get",
    path: "/form-options",
    tags: ["Admin - Collections"],
    summary: "Get categories and products for collection form",
    responses: {
        200: {
            description: "Form options",
            content: { "application/json": { schema: successEnvelope(z.object({
                categories: z.array(z.object({ id: z.string(), name: z.string() })),
                products: z.array(z.object({
                    id: z.string(),
                    name: z.string(),
                    price: z.number(),
                    categoryId: z.string().nullable(),
                })),
            })) } },
        },
        ...errorResponses,
    }
});

app.openapi(formOptionsRoute, async (c) => {
    const db = c.get("db");
    const [allCategories, allProducts] = await Promise.all([
        db.select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(isNull(categories.deletedAt))
            .limit(500),
        db.select({
            id: products.id,
            name: products.name,
            price: products.price,
            categoryId: products.categoryId,
        })
            .from(products)
            .where(isNull(products.deletedAt))
            .limit(500),
    ]);
    return ok(c, { categories: allCategories, products: allProducts });
});

// ── Category Options (lightweight collection form options) ──

const categoryOptionsRoute = createRoute({
    method: "get",
    path: "/category-options",
    tags: ["Admin - Collections"],
    summary: "Get categories for collection forms",
    responses: {
        200: {
            description: "Category options",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        categories: z.array(collectionOptionSchema),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(categoryOptionsRoute, async (c) => {
    const db = c.get("db");
    const categoryOptions = await getCollectionCategoryOptions(db);
    return ok(c, { categories: categoryOptions });
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
            limit: z.coerce.number().max(100).default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("sortOrder").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: {
            description: "Collection list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("collections", collectionSchema) } },
        },
        ...errorResponses,
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

// ── Collection Picker Summaries ──

const getByIdsRoute = createRoute({
    method: "get",
    path: "/by-ids",
    tags: ["Admin - Collections"],
    summary: "Get lightweight collection summaries for known IDs",
    request: {
        query: z.object({
            ids: z.string().optional().default("").openapi({
                description: "Comma-separated collection IDs. At most 100 IDs are resolved.",
            }),
        }),
    },
    responses: {
        200: {
            description: "Collection summaries",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        collections: z.array(collectionPickerSummarySchema),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getByIdsRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("query");
    const collections = await getCollectionsByIds(db, parseLookupIds(ids));
    return ok(c, { collections });
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
        201: {
            description: "Collection created",
            content: { "application/json": { schema: successEnvelope(collectionSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(createCollectionRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const collection = await createCollection(db, data);
    await invalidateCatalogCaches("collections", c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { collectionIds, permanent } = c.req.valid("json");
    await bulkDeleteCollections(db, collectionIds, permanent);
    await invalidateCatalogCaches("collections", c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkActivateRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkActivateCollections(db, ids);
    await invalidateCatalogCaches("collections", c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeactivateRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await bulkDeactivateCollections(db, ids);
    await invalidateCatalogCaches("collections", c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("json");
    await restoreCollections(db, ids);
    await invalidateCatalogCaches("collections", c);
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
        200: {
            description: "Collection restored",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    // Note: do NOT call getCollectionById here — it filters deletedAt IS NULL,
    // which would always 404 for soft-deleted collections being restored
    await restoreCollections(db, [id]);
    await invalidateCatalogCaches("collections", c);
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
        200: {
            description: "Collections reordered",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(reorderRoute, async (c) => {
    const db = c.get("db");
    const { items } = c.req.valid("json");
    await reorderCollections(db, items);
    await invalidateCatalogCaches("collections", c);
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
        200: {
            description: "Collection details",
            content: { "application/json": { schema: successEnvelope(collectionSchema) } },
        },
        404: errorResponses[404],
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
        200: {
            description: "Collection updated",
            content: { "application/json": { schema: successEnvelope(collectionSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(updateCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await updateCollection(db, id, c.req.valid("json"));
    await invalidateCatalogCaches("collections", c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteCollection(db, id);
    await invalidateCatalogCaches("collections", c);
    return noContent(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await bulkDeleteCollections(db, [id], true);
    await invalidateCatalogCaches("collections", c);
    return noContent(c);
});

export { app as adminCollectionRoutes };
