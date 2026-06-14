// src/server/routes/admin/discounts.ts
// Admin OpenAPI routes for discounts.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { listDiscounts, getDiscountById, createDiscount, updateDiscount, deleteDiscount, bulkDeleteDiscounts, restoreDiscounts, permanentlyDeleteDiscount, createDiscountSchema, updateDiscountSchema } from "@scalius/core/modules/discounts";
import { DiscountType, discounts } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, paginatedEnvelope, noContentResponse, errorResponses } from "../../schemas/responses";
import { discountSchema } from "../../schemas/entities";
import { invalidateCatalogCaches } from "../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ── List Discounts ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Discounts"],
    summary: "List all discounts",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            type: z.enum([
                DiscountType.AMOUNT_OFF_PRODUCTS,
                DiscountType.AMOUNT_OFF_ORDER,
                DiscountType.FREE_SHIPPING,
            ]).optional().openapi({ description: "Filter by discount type" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Discount list with pagination", content: { "application/json": { schema: paginatedEnvelope("discounts", discountSchema) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await listDiscounts(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        showTrashed: query.trashed === "true",
        type: query.type,
        sort: query.sort || "updatedAt",
        order: (query.order || "desc") as "asc" | "desc"
    });
    return ok(c, result);
});

// ── Create Discount ──

const createDiscountRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Discounts"],
    summary: "Create a discount",
    request: {
        body: { content: { "application/json": { schema: createDiscountSchema } } }
    },
    responses: {
        201: { description: "Discount created", content: { "application/json": { schema: successEnvelope(discountSchema) } } },
        ...errorResponses,
    }
});

app.openapi(createDiscountRoute, (async (c: AdminRouteContext<typeof createDiscountRoute>) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await createDiscount(db, data);
    await invalidateCatalogCaches("discounts", c);
    return created(c, result);
}) as unknown as AdminRouteHandler<typeof createDiscountRoute>);

// ── Bulk Delete Discounts ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Discounts"],
    summary: "Bulk delete discounts",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        discountIds: z.array(z.string()),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { discountIds, permanent } = c.req.valid("json");
    if (discountIds.length === 0) throw new ValidationError("No discount IDs provided");
    await bulkDeleteDiscounts(db, discountIds, permanent);
    await invalidateCatalogCaches("discounts", c);
    return noContent(c);
});

// ── Bulk Restore Discounts ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Discounts"],
    summary: "Bulk restore discounts",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ discountIds: z.array(z.string()) })
                }
            }
        }
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { discountIds } = c.req.valid("json");
    if (discountIds.length === 0) throw new ValidationError("No discount IDs provided");
    await restoreDiscounts(db, discountIds);
    await invalidateCatalogCaches("discounts", c);
    return noContent(c);
});

// ── Get Discount By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Get a discount by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Discount details", content: { "application/json": { schema: successEnvelope(discountSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, (async (c: AdminRouteContext<typeof getByIdRoute>) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const discount = await getDiscountById(db, id);
    if (!discount) throw new NotFoundError("Discount not found");
    return ok(c, discount);
}) as unknown as AdminRouteHandler<typeof getByIdRoute>);

// ── Update Discount ──

const updateDiscountRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Update a discount",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateDiscountSchema } } }
    },
    responses: {
        200: { description: "Discount updated", content: { "application/json": { schema: successEnvelope(discountSchema) } } },
        ...errorResponses,
    }
});

app.openapi(updateDiscountRoute, (async (c: AdminRouteContext<typeof updateDiscountRoute>) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const result = await updateDiscount(db, id, data);
    await invalidateCatalogCaches("discounts", c);
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof updateDiscountRoute>);

// ── Delete Discount ──

const deleteDiscountRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Soft-delete a discount",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(deleteDiscountRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteDiscount(db, id);
    await invalidateCatalogCaches("discounts", c);
    return noContent(c);
});

// ── Permanent Delete Discount ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Discounts"],
    summary: "Permanently delete a discount",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteDiscount(db, id);
    await invalidateCatalogCaches("discounts", c);
    return noContent(c);
});

// ── Toggle Discount Status ──

const toggleStatusRoute = createRoute({
    method: "post",
    path: "/{id}/toggle-status",
    tags: ["Admin - Discounts"],
    summary: "Toggle a discount's active status",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        isActive: z.boolean()
                    })
                }
            }
        }
    },
    responses: {
        200: { description: "Discount status toggled", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string(), isActive: z.boolean() })) } } },
        ...errorResponses,
    }
});

app.openapi(toggleStatusRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const discount = await getDiscountById(db, id);
    if (!discount) throw new NotFoundError("Discount not found");
    await db.update(discounts).set({ isActive, updatedAt: sql`unixepoch()` }).where(eq(discounts.id, id));
    await invalidateCatalogCaches("discounts", c);
    return ok(c, { id, isActive });
});

// ── Restore Discount ──

const restoreDiscountRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Discounts"],
    summary: "Restore a soft-deleted discount",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Discount restored", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(restoreDiscountRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreDiscounts(db, [id]);
    await invalidateCatalogCaches("discounts", c);
    return ok(c, {});
});

export { app as adminDiscountRoutes };
