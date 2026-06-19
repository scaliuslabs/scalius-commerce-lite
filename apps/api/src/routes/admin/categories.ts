// src/server/routes/admin/categories.ts
// Admin OpenAPI routes for categories.
// All DB logic is delegated to src/modules/categories/categories.service.ts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok, created, noContent } from "../../utils/api-response";
import { ValidationError, NotFoundError } from "../../utils/api-error";
import {
    listCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory,
    bulkDeleteCategories,
    restoreCategories,
    permanentlyDeleteCategory,
    createCategorySchema,
    updateCategorySchema
} from "@scalius/core/modules/categories";
import type { Database } from "@scalius/database/client";
import { categories } from "@scalius/database/schema";
import { inArray, isNull } from "drizzle-orm";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    idResponse,
    noContentResponse,
} from "../../schemas/responses";
import { categoryDetailSchema, categorySummarySchema } from "../../schemas/entities";
import {
    invalidateCatalogCaches,
    MAX_STOREFRONT_EXACT_HTML_PATHS,
} from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();

function categoryHtmlPath(slug: string | null | undefined): string[] {
    return slug ? [`/categories/${slug}`] : [];
}

async function categoryHtmlPathsByIds(
    db: Database,
    categoryIds: readonly string[],
): Promise<string[]> {
    const ids = [...new Set(categoryIds.filter(Boolean))]
        .slice(0, MAX_STOREFRONT_EXACT_HTML_PATHS);
    if (ids.length === 0) return [];

    const rows = await db
        .select({ slug: categories.slug })
        .from(categories)
        .where(inArray(categories.id, ids));

    return rows.flatMap((category) => categoryHtmlPath(category.slug));
}

// ── Form Options (lightweight for dropdowns) ──

const formOptionsRoute = createRoute({
    method: "get",
    path: "/form-options",
    tags: ["Admin - Categories"],
    summary: "Get active categories for form dropdowns",
    responses: {
        200: {
            description: "Category options",
            content: { "application/json": { schema: successEnvelope(z.object({
                categories: z.array(z.object({ id: z.string(), name: z.string() })),
            })) } },
        },
        ...errorResponses,
    }
});

app.openapi(formOptionsRoute, async (c) => {
    const db = c.get("db");
    const result = await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(isNull(categories.deletedAt));
    return ok(c, { categories: result });
});

// ── List Categories ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Categories"],
    summary: "List all categories",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(500).default(10).openapi({ description: "Items per page (max 500 for selector dropdowns)" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
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
        showTrashed: query.trashed === "true",
        sort: query.sort as "name" | "createdAt" | "updatedAt" | undefined,
        order: query.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

// ── Get Category by ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Categories"],
    summary: "Get a single category by ID",
    request: {
        params: z.object({ id: z.string() }),
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
    tags: ["Admin - Categories"],
    summary: "Create a category",
    request: {
        body: { content: { "application/json": { schema: createCategorySchema } } }
    },
    responses: {
        201: {
            description: "Category created",
            content: { "application/json": { schema: idResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(createCategoryRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createCategory(db, data);
    await invalidateCatalogCaches("categories", c, {
        htmlPaths: categoryHtmlPath(data.slug),
    });
    return created(c, result);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { categoryIds, permanent } = c.req.valid("json");
    if (categoryIds.length === 0) throw new ValidationError("No category IDs provided");
    const htmlPaths = await categoryHtmlPathsByIds(db, categoryIds);
    await bulkDeleteCategories(db, categoryIds, permanent);
    await invalidateCatalogCaches("categories", c, { htmlPaths });
    return noContent(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { categoryIds } = c.req.valid("json");
    if (categoryIds.length === 0) throw new ValidationError("No category IDs provided");
    const htmlPaths = await categoryHtmlPathsByIds(db, categoryIds);
    await restoreCategories(db, categoryIds);
    await invalidateCatalogCaches("categories", c, { htmlPaths });
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
        200: {
            description: "Category updated",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(updateCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const existing = await getCategoryById(db, id);
    await updateCategory(db, id, data);
    await invalidateCatalogCaches("categories", c, {
        htmlPaths: [
            ...categoryHtmlPath(existing?.slug),
            ...categoryHtmlPath(data.slug),
        ],
    });
    return ok(c, {});
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const htmlPaths = await categoryHtmlPathsByIds(db, [id]);
    await deleteCategory(db, id);
    await invalidateCatalogCaches("categories", c, { htmlPaths });
    return noContent(c);
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
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const htmlPaths = await categoryHtmlPathsByIds(db, [id]);
    await permanentlyDeleteCategory(db, id);
    await invalidateCatalogCaches("categories", c, { htmlPaths });
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
        200: {
            description: "Category restored",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(restoreCategoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const htmlPaths = await categoryHtmlPathsByIds(db, [id]);
    await restoreCategories(db, [id]);
    await invalidateCatalogCaches("categories", c, { htmlPaths });
    return ok(c, {});
});

export { app as adminCategoryRoutes };
