// src/server/routes/admin/collections.ts
// Admin OpenAPI routes for collections.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listCollections,
    getCollectionById,
    getCollectionSection,
    getCollectionCategoryOptions,
    getCollectionsByIds,
    createCollection,
    updateCollection,
    updateCollectionProducts,
    updateCollectionProductsSchema,
    deleteCollection,
    bulkDeleteCollections,
    bulkActivateCollections,
    bulkDeactivateCollections,
    restoreCollections,
    reorderCollections,
    createCollectionSchema,
    updateCollectionSchema
} from "@scalius/core/modules/collections";
import { listCollectionProductOptions } from "@scalius/core/modules/catalog";
import { categories, products } from "@scalius/database/schema";
import { isNull } from "drizzle-orm";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { fromMinor } from "@scalius/shared/money";
import { NotFoundError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    paginationSchema,
    errorResponses,
    conflictResponse,
    noContentResponse,
} from "../../schemas/responses";
import { buyerPriceRangeSchema, collectionSchema, collectionSummarySchema } from "../../schemas/entities";
import { CollectionResource, presentCollection, readCollectionResource } from "./resources-catalog-content";

import { categoryStatusSchema } from "@scalius/shared/category-publication";
const app = new OpenAPIHono<{ Bindings: Env }>();

const collectionOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
});

const collectionCategoryOptionSchema = collectionOptionSchema.extend({
    status: categoryStatusSchema,
});

const collectionPickerSummarySchema = collectionOptionSchema.extend({
    presentation: z.enum(["grid", "carousel"]),
});

const collectionProductOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    priceRange: buyerPriceRangeSchema,
    categoryId: z.string().nullable(),
    categoryName: z.string().nullable(),
    isActive: z.boolean(),
    primaryImage: z.string().nullable(),
    /** Optioned SKUs; 0 for a simple product. */
    variantCount: z.number().int().nonnegative(),
    /** Sellable units across tracked SKUs; null when no SKU tracks stock. */
    available: z.number().int().nonnegative().nullable(),
});

function parseLookupIds(ids: string | undefined): string[] {
    return Array.from(new Set((ids ?? "").split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 90);
}

const collectionIdsSchema = z.array(z.string().trim().min(1).max(180)).min(1).max(90);
const collectionSectionSchema = z.enum(["summary", "text"]);
const collectionTextFieldSchema = z.enum(["description", "content"]);
/** Every collection write answers the collection as `collections.get` reads it. */
const collectionEnvelope = successEnvelope(z.object({ collection: CollectionResource }));

// A collection exposes `revision` and every write takes `expectedRevision`
// (the collections service keeps its `version` column and parameter names).
const expectedRevisionField = z.number().int().min(1).openapi({
    description: "The collection's `revision` you read; a collection changed since is refused with 409 and nothing changes.",
});
const updateCollectionBody = updateCollectionSchema.omit({ expectedVersion: true }).extend({ expectedRevision: expectedRevisionField });
const updateCollectionProductsBody = updateCollectionProductsSchema.omit({ expectedVersion: true }).extend({ expectedRevision: expectedRevisionField });

/** A collection row or projection as the dashboard's own reads carry it: `version` is its `revision`. */
function withRevision<T extends { version: number }>(row: T): Omit<T, "version"> & { revision: number } {
    const { version, ...rest } = row;
    return { ...rest, revision: version };
}

function parseProductOptionCategoryIds(ids: string | undefined): string[] {
    return Array.from(
        new Set((ids ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
    ).slice(0, 90);
}

// ── Form Options (categories + products for collection form) ──

const formOptionsRoute = createRoute({
    method: "get",
    path: "/form-options",
    operationId: "dashboard.collections.form_options",
    tags: ["Admin - Collections"],
    summary: "Get categories and products for collection form",
    responses: {
        200: {
            description: "Form options",
            content: { "application/json": { schema: successEnvelope(z.object({
                categories: z.array(collectionCategoryOptionSchema),
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
    const [allCategories, allProducts, currency] = await Promise.all([
        db.select({ id: categories.id, name: categories.name, status: categories.status })
            .from(categories)
            .where(isNull(categories.deletedAt))
            .limit(500),
        db.select({
            id: products.id,
            name: products.name,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
        })
            .from(products)
            .where(isNull(products.deletedAt))
            .limit(500),
        getCurrencyConfig(db),
    ]);
    return ok(c, {
        categories: allCategories,
        products: allProducts.map(({ priceMinor, ...product }) => ({
            ...product,
            price: fromMinor(priceMinor, currency.decimalPlaces),
        })),
    });
});

// ── Category Options (lightweight collection form options) ──

const categoryOptionsRoute = createRoute({
    method: "get",
    path: "/category-options",
    operationId: "dashboard.collections.category_options",
    tags: ["Admin - Collections"],
    summary: "Get categories for collection forms",
    responses: {
        200: {
            description: "Category options",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        categories: z.array(collectionCategoryOptionSchema),
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

// ── Product Options (server-filtered collection picker) ──

const productOptionsRoute = createRoute({
    method: "get",
    path: "/product-options",
    operationId: "dashboard.collections.product_options",
    tags: ["Admin - Collections"],
    summary: "Search products for collection forms",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(20).default(10),
            search: z.string().trim().max(100).optional().default(""),
            categoryIds: z.string().max(10000).optional().default("").openapi({
                description: "Comma-separated category IDs. At most 90 IDs are applied.",
            }),
            selectedProductIds: z.string().max(10000).optional().default("").openapi({
                description: "Comma-separated selected product IDs sorted after addable products.",
            }),
        }),
    },
    responses: {
        200: {
            description: "Paginated product options",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        products: z.array(collectionProductOptionSchema),
                        pagination: paginationSchema,
                        visibleOnline: z.number().int().nullable().openapi({
                            description: "With categoryIds: how many of their products buyers see on the storefront. Null without categories.",
                        }),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(productOptionsRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listCollectionProductOptions(db, {
        page: query.page,
        limit: query.limit,
        search: query.search,
        categoryIds: parseProductOptionCategoryIds(query.categoryIds),
        selectedProductIds: parseLookupIds(query.selectedProductIds),
    });
    return ok(c, result);
});

// ── List Collections ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.collections.list",
    tags: ["Admin - Collections"],
    summary: "List all collections",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ description: "Items per page" }),
            search: z.string().trim().max(120).optional().default("").openapi({ description: "Search term" }),
            trashed: z.enum(["true", "false"]).optional().openapi({ description: "Show trashed items" }),
            sort: z.enum(["name", "presentation", "isActive", "updatedAt", "sortOrder"]).optional().default("sortOrder").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: {
            description: "Collection list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("collections", collectionSummarySchema) } },
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
        sort: q.sort,
        order: q.order
    });
    return ok(c, { ...result, collections: result.collections.map(withRevision) });
});

// ── Collection Picker Summaries ──

const getByIdsRoute = createRoute({
    method: "get",
    path: "/by-ids",
    operationId: "dashboard.collections.get_by_ids",
    tags: ["Admin - Collections"],
    summary: "Get lightweight collection summaries for known IDs",
    request: {
        query: z.object({
            ids: z.string().optional().default("").openapi({
                description: "Comma-separated collection IDs. At most 90 IDs are resolved.",
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
    operationId: "dashboard.collections.create",
    tags: ["Admin - Collections"],
    summary: "Create a collection",
    request: {
        body: { content: { "application/json": { schema: createCollectionSchema } } }
    },
    responses: {
        201: {
            description: "The new collection",
            content: { "application/json": { schema: collectionEnvelope } },
        },
        ...errorResponses,
    }
});

app.openapi(createCollectionRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const collection = await createCollection(db, data);
    return created(c, { collection: presentCollection(collection) });
});

// ── Bulk Delete Collections ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    operationId: "dashboard.collections.bulk_delete",
    tags: ["Admin - Collections"],
    summary: "Bulk delete collections",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        collectionIds: collectionIdsSchema,
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

    return noContent(c);
});

// ── Bulk Activate Collections ──

const bulkActivateRoute = createRoute({
    method: "post",
    path: "/bulk-activate",
    operationId: "dashboard.collections.bulk_activate",
    tags: ["Admin - Collections"],
    summary: "Bulk activate collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: collectionIdsSchema }) } } }
    },
    responses: {
        204: noContentResponse,
        409: conflictResponse,
        ...errorResponses,
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
    operationId: "dashboard.collections.bulk_deactivate",
    tags: ["Admin - Collections"],
    summary: "Bulk deactivate collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: collectionIdsSchema }) } } }
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

    return noContent(c);
});

// ── Bulk Restore Collections ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    operationId: "dashboard.collections.bulk_restore",
    tags: ["Admin - Collections"],
    summary: "Bulk restore collections",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: collectionIdsSchema }) } } }
    },
    responses: {
        204: noContentResponse,
        409: conflictResponse,
        ...errorResponses,
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
    operationId: "dashboard.collections.restore",
    tags: ["Admin - Collections"],
    summary: "Restore a collection from the trash",
    description: "Answers the restored collection.",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: z.object({ expectedRevision: expectedRevisionField }) } } },
    },
    responses: {
        200: {
            description: "The restored collection",
            content: { "application/json": { schema: collectionEnvelope } },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreCollections(db, [id], { expectedVersion: c.req.valid("json").expectedRevision });
    return ok(c, { collection: await readCollectionResource(db, id) });
});

// ── Reorder Collections ──

const reorderRoute = createRoute({
    method: "post",
    path: "/reorder",
    operationId: "dashboard.collections.reorder",
    tags: ["Admin - Collections"],
    summary: "Reorder collections",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        items: z.array(z.object({
                            id: z.string().trim().min(1).max(180),
                            sortOrder: z.number().int().min(0),
                            expectedRevision: expectedRevisionField,
                        })).min(1).max(90)
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
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(reorderRoute, async (c) => {
    const db = c.get("db");
    const { items } = c.req.valid("json");
    await reorderCollections(db, items.map(({ expectedRevision, ...item }) => ({ ...item, expectedVersion: expectedRevision })));

    return ok(c, {});
});

// ── Get Bounded Collection Section ──

const getCollectionSectionRoute = createRoute({
    method: "get",
    path: "/{id}/sections/{section}",
    operationId: "dashboard.collections.get_section",
    tags: ["Admin - Collections"],
    summary: "Get a bounded collection section",
    request: {
        params: z.object({ id: z.string(), section: collectionSectionSchema }),
        query: z.object({
            field: collectionTextFieldSchema.optional(),
            offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
        }),
    },
    responses: {
        200: {
            description: "Bounded collection section",
            content: { "application/json": { schema: successEnvelope(z.union([
                z.object({
                    section: z.literal("summary"),
                    collection: collectionSummarySchema.extend({
                        metaTitle: z.string().nullable(),
                        metaDescription: z.string().nullable(),
                        descriptionCharacters: z.number().int().min(0),
                        contentCharacters: z.number().int().min(0),
                    }),
                }),
                z.object({
                    section: z.literal("text"),
                    field: collectionTextFieldSchema,
                    value: z.string().max(12_000),
                    totalCharacters: z.number().int().min(0),
                    offset: z.number().int().min(0),
                    nextOffset: z.number().int().min(0).nullable(),
                    isNull: z.boolean(),
                }),
            ])) } },
        },
        404: errorResponses[404],
    },
});

app.openapi(getCollectionSectionRoute, async (c) => {
    const { id, section } = c.req.valid("param");
    const query = c.req.valid("query");
    const result = await getCollectionSection(c.get("db"), id, section, query);
    if (!result) throw new NotFoundError("Collection not found");
    return ok(c, result.section === "summary" ? { ...result, collection: withRevision(result.collection) } : result);
});

// ── Get Collection By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    operationId: "dashboard.collections.get",
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
    return ok(c, withRevision(collection));
});

// ── Update Collection ──

const updateCollectionRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.collections.update",
    tags: ["Admin - Collections"],
    summary: "Update a collection",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCollectionBody } } }
    },
    responses: {
        200: {
            description: "The collection as updated",
            content: { "application/json": { schema: collectionEnvelope } },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(updateCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision, ...changes } = c.req.valid("json");
    const collection = await updateCollection(db, id, { ...changes, expectedVersion: expectedRevision });
    return ok(c, { collection: presentCollection(collection) });
});

// ── Add / remove products (manual collections) ──

const updateCollectionProductsRoute = createRoute({
    method: "post",
    path: "/{id}/products",
    operationId: "dashboard.collections.update_products",
    tags: ["Admin - Collections"],
    summary: "Add or remove products in a manual collection",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCollectionProductsBody } } },
    },
    responses: {
        200: {
            description: "The collection with its new products",
            content: { "application/json": { schema: collectionEnvelope } },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

app.openapi(updateCollectionProductsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision, ...change } = c.req.valid("json");
    await updateCollectionProducts(db, id, { ...change, expectedVersion: expectedRevision });
    return ok(c, { collection: await readCollectionResource(db, id) });
});

// ── Delete Collection ──

const deleteCollectionRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.collections.trash",
    tags: ["Admin - Collections"],
    summary: "Move a collection to the trash",
    description: "Answers the trashed collection.",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            expectedRevision: z.coerce.number().int().min(1).openapi({
                description: "The collection's `revision` you read; a collection changed since is refused with 409 and nothing changes.",
            }),
        }),
    },
    responses: {
        200: {
            description: "The trashed collection",
            content: { "application/json": { schema: collectionEnvelope } },
        },
        409: conflictResponse,
        ...errorResponses,
    }
});

app.openapi(deleteCollectionRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteCollection(db, id, { expectedVersion: c.req.valid("query").expectedRevision });
    return ok(c, { collection: await readCollectionResource(db, id) });
});

// ── Permanent Delete Collection ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    operationId: "dashboard.collections.delete_permanently",
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

    return noContent(c);
});

export { app as adminCollectionRoutes };
