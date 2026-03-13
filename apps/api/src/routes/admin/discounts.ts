// src/server/routes/admin/discounts.ts
// Admin OpenAPI routes for discounts.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DiscountService, createDiscountSchema, updateDiscountSchema } from "@scalius/core/modules/discounts";
import { NotFoundError } from "../../utils/api-error";

const app = new OpenAPIHono();

// ── List Discounts ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Discounts"],
    summary: "List all discounts",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" }),
        }),
    },
    responses: {
        200: { description: "Discount list with pagination", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await DiscountService.list(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        showTrashed: query.trashed === "true",
        sort: query.sort || "updatedAt",
        order: query.order || "desc",
    });
    return c.json(result, 200);
});

// ── Create Discount ──

const createDiscountRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Discounts"],
    summary: "Create a discount",
    request: {
        body: { content: { "application/json": { schema: createDiscountSchema } } },
    },
    responses: {
        201: { description: "Discount created", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(createDiscountRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await DiscountService.create(db, data);
        return c.json(result, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

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
                        permanent: z.boolean().default(false),
                    }),
                },
            },
        },
    },
    responses: {
        204: { description: "Discounts deleted" },
    },
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { discountIds, permanent } = c.req.valid("json");
    if (discountIds.length === 0) return c.json({ error: "No discount IDs provided" }, 400);
    await DiscountService.bulkDelete(db, discountIds, permanent);
    return c.body(null, 204);
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
                    schema: z.object({ discountIds: z.array(z.string()) }),
                },
            },
        },
    },
    responses: {
        204: { description: "Discounts restored" },
    },
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    const { discountIds } = c.req.valid("json");
    if (discountIds.length === 0) return c.json({ error: "No discount IDs provided" }, 400);
    await DiscountService.restore(db, discountIds);
    return c.body(null, 204);
});

// ── Get Discount By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Get a discount by ID",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Discount ID" }) }),
    },
    responses: {
        200: { description: "Discount details", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const discount = await DiscountService.getById(db, id);
    if (!discount) throw new NotFoundError("Discount not found");
    return c.json(discount, 200);
});

// ── Update Discount ──

const updateDiscountRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Update a discount",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Discount ID" }) }),
        body: { content: { "application/json": { schema: updateDiscountSchema } } },
    },
    responses: {
        200: { description: "Discount updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(updateDiscountRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const result = await DiscountService.update(db, id, data);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message }, error.statusCode || 400);
    }
});

// ── Delete Discount ──

const deleteDiscountRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Discounts"],
    summary: "Soft-delete a discount",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Discount ID" }) }),
    },
    responses: {
        204: { description: "Discount deleted" },
    },
});

app.openapi(deleteDiscountRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await DiscountService.delete(db, id);
    return c.body(null, 204);
});

// ── Permanent Delete Discount ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Discounts"],
    summary: "Permanently delete a discount",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Discount ID" }) }),
    },
    responses: {
        204: { description: "Discount permanently deleted" },
    },
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await DiscountService.permanentlyDelete(db, id);
    return c.body(null, 204);
});

// ── Restore Discount ──

const restoreDiscountRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Discounts"],
    summary: "Restore a soft-deleted discount",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Discount ID" }) }),
    },
    responses: {
        200: { description: "Discount restored", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(restoreDiscountRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await DiscountService.restore(db, [id]);
    return c.json({ success: true }, 200);
});

export { app as adminDiscountRoutes };
