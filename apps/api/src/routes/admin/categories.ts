// src/server/routes/admin/categories.ts
// Admin OpenAPI routes for categories.
// All DB logic is delegated to src/modules/categories/categories.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok, created, noContent } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import {
    listCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    updateCategoryStatus,
    deleteCategory,
    bulkDeleteCategories,
    restoreCategories,
    permanentlyDeleteCategory,
    createCategorySchema,
    updateCategorySchema,
    updateCategoryStatusSchema,
    categoryRevisionClaimSchema,
    getCategoryPublishReadiness,
    CATEGORY_BATCH_LIMIT,
} from "@scalius/core/modules/categories";
import { categories } from "@scalius/database/schema";
import { asc, isNull } from "drizzle-orm";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    conflictResponse,
    noContentResponse,
} from "../../schemas/responses";
import { categoryDetailSchema, categorySummarySchema } from "../../schemas/entities";
import { categoryStatusSchema } from "@scalius/shared/category-publication";
import { invalidateCatalogCaches } from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();
const categoryIdSchema = z.string().trim().min(1).max(180);
const categoryIdsSchema = z
    .array(categoryRevisionClaimSchema)
    .min(1)
    .max(CATEGORY_BATCH_LIMIT);
const categoryMutationResultSchema = z.object({
    revision: z.number().int().min(1),
    status: categoryStatusSchema,
});
const categoryPublishReadinessSchema = z.object({
    ready: z.boolean(),
    eligibleProductCount: z.number().int().min(0),
    blockers: z.array(z.object({ code: z.string(), message: z.string() })),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

// ── Form Options (lightweight for dropdowns) ──

const formOptionsRoute = createRoute({
    method: "get",
    path: "/form-options",
    operationId: "dashboard.categories.form_options",
    tags: ["Admin - Categories"],
    summary: "Get active categories for form dropdowns",
    responses: {
        200: {
            description: "Category options",
            content: { "application/json": { schema: successEnvelope(z.object({
                categories: z.array(z.object({
                    id: z.string(),
                    name: z.string(),
                    status: categoryStatusSchema,
                })),
            })) } },
        },
        ...errorResponses,
    }
});

app.openapi(formOptionsRoute, async (c) => {
    const db = c.get("db");
    const result = await db
        .select({ id: categories.id, name: categories.name, status: categories.status })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(asc(categories.name), asc(categories.id));
    return ok(c, { categories: result });
});

// ── List Categories ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.categories.list",
    tags: ["Admin - Categories"],
    summary: "List all categories",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).max(100_000).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(500).default(10).openapi({ description: "Items per page (max 500 for selector dropdowns)" }),
            search: z.string().trim().max(100).optional().default("").openapi({ description: "Search term" }),
            status: categoryStatusSchema.optional().openapi({ description: "Publication status" }),
            trashed: z.enum(["true", "false"]).optional().openapi({ description: "Show trashed items" }),
            sort: z.enum(["name", "status", "createdAt", "updatedAt"]).optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: {
            description: "Category list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("categories", categorySummarySchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listCategories(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        status: query.status,
        showTrashed: query.trashed === "true",
        sort: query.sort,
        order: query.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

const publishReadinessRoute = createRoute({
    method: "get",
    path: "/{id}/publish-readiness",
    operationId: "dashboard.categories.publish_readiness",
    tags: ["Admin - Categories"],
    summary: "Get category publication readiness",
    request: { params: z.object({ id: categoryIdSchema }) },
    responses: {
        200: {
            description: "Category publication readiness",
            content: { "application/json": { schema: successEnvelope(categoryPublishReadinessSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(publishReadinessRoute, async (c) => {
    const readiness = await getCategoryPublishReadiness(c.get("db"), c.req.valid("param").id);
    if (!readiness) throw new NotFoundError("Category not found");
    return ok(c, readiness);
});

// ── Get Category by ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    operationId: "dashboard.categories.get",
    tags: ["Admin - Categories"],
    summary: "Get a single category by ID",
    request: {
        params: z.object({ id: categoryIdSchema }),
    },
    responses: {
        200: {
            description: "Category details",
            content: { "application/json": { schema: successEnvelope(categoryDetailSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const category = await getCategoryById(db, id);
    if (!category) throw new NotFoundError("Category not found");
    return ok(c, category);
});

// ── Create Category ──

const createCategoryRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.categories.create",
    tags: ["Admin - Categories"],
    summary: "Create a category",
    request: {
        body: { content: { "application/json": { schema: createCategorySchema } } }
    },
    responses: {
        201: {
            description: "Category created",
            content: { "application/json": { schema: successEnvelope(z.object({
                id: z.string(),
                revision: z.number().int().min(1),
                status: z.literal("draft"),
            })) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(createCategoryRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createCategory(db, data);
    await invalidateCatalogCaches("categories", c);
    return created(c, result);
});

// ── Bulk Delete Categories ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    operationId: "dashboard.categories.bulk_delete",
    tags: ["Admin - Categories"],
    summary: "Bulk delete categories",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        categories: categoryIdsSchema,
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { categories: revisionClaims, permanent } = c.req.valid("json");
    await bulkDeleteCategories(db, revisionClaims, permanent);
    await invalidateCatalogCaches("categories", c);
    return noContent(c);
});

// ── Bulk Restore Categories ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    operationId: "dashboard.categories.bulk_restore",
    tags: ["Admin - Categories"],
    summary: "Bulk restore categories",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ categories: categoryIdsSchema })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { categories: revisionClaims } = c.req.valid("json");
    await restoreCategories(db, revisionClaims);
    await invalidateCatalogCaches("categories", c);
    return noContent(c);
});

// ── Update Category ──

const updateCategoryRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.categories.update",
    tags: ["Admin - Categories"],
    summary: "Update a category",
    request: {
        params: z.object({ id: categoryIdSchema }),
        body: { content: { "application/json": { schema: updateCategorySchema } } }
    },
    responses: {
        200: {
            description: "Category updated",
            content: { "application/json": { schema: successEnvelope(categoryMutationResultSchema) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(updateCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const result = await updateCategory(db, id, data);
    await invalidateCatalogCaches("categories", c);
    return ok(c, result);
});

const updateStatusRoute = createRoute({
    method: "patch",
    path: "/{id}/status",
    operationId: "dashboard.categories.set_status",
    tags: ["Admin - Categories"],
    summary: "Change category publication status",
    request: {
        params: z.object({ id: categoryIdSchema }),
        body: { content: { "application/json": { schema: updateCategoryStatusSchema } } },
    },
    responses: {
        200: {
            description: "Category status changed",
            content: { "application/json": { schema: successEnvelope(categoryMutationResultSchema) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(updateStatusRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const result = await updateCategoryStatus(db, id, data);
    await invalidateCatalogCaches("categories", c);
    return ok(c, result);
});

// ── Delete Category ──

const deleteCategoryRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.categories.trash",
    tags: ["Admin - Categories"],
    summary: "Soft-delete a category",
    request: {
        params: z.object({ id: categoryIdSchema }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().min(1),
        }) } } },
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(deleteCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    await deleteCategory(db, id, expectedRevision);
    await invalidateCatalogCaches("categories", c);
    return noContent(c);
});

// ── Permanent Delete Category ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    operationId: "dashboard.categories.delete_permanently",
    tags: ["Admin - Categories"],
    summary: "Permanently delete a category",
    request: {
        params: z.object({ id: categoryIdSchema }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().min(1),
        }) } } },
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    await permanentlyDeleteCategory(db, id, expectedRevision);
    await invalidateCatalogCaches("categories", c);
    return noContent(c);
});

// ── Restore Category ──

const restoreCategoryRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    operationId: "dashboard.categories.restore",
    tags: ["Admin - Categories"],
    summary: "Restore a soft-deleted category",
    request: {
        params: z.object({ id: categoryIdSchema }),
        body: { content: { "application/json": { schema: z.object({
            expectedRevision: z.number().int().min(1),
        }) } } },
    },
    responses: {
        200: {
            description: "Category restored",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(restoreCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    await restoreCategories(db, [{ id, expectedRevision }]);
    await invalidateCatalogCaches("categories", c);
    return ok(c, {});
});

export { app as adminCategoryRoutes };
