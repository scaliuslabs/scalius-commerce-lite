import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { sql, eq, and, or, isNull, like, asc, desc } from "drizzle-orm";
import { shippingMethods } from "@scalius/database/schema";
import { NotFoundError, ConflictError } from "../../../utils/api-error";

const app = new OpenAPIHono();

const createShippingMethodSchema = z.object({
    name: z.string().min(1, "Name is required").max(100),
    fee: z.number().min(0, "Fee must be a positive number"),
    description: z.string().max(255).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().optional().default(0),
});

const updateShippingMethodSchema = z.object({
    name: z.string().min(1, "Name is required").max(100).optional(),
    fee: z.number().min(0, "Fee must be a positive number").optional(),
    description: z.string().max(255).optional().nullable(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
});

// ── List Shipping Methods ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Shipping Methods"],
    summary: "List all shipping methods",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.string().optional().default("sortOrder").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
        }),
    },
    responses: { 200: { description: "Shipping method list", content: { "application/json": { schema: z.any() } } } },
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    try {
        const query = c.req.valid("query");
        const page = query.page;
        const limit = query.limit;
        const search = query.search || "";
        const sortField = (query.sort || "sortOrder") as any;
        const sortOrder = (query.order || "asc") as "asc" | "desc";
        const showTrashed = query.trashed === "true";

        const offset = (page - 1) * limit;

        const whereConditions = [];
        if (showTrashed) {
            whereConditions.push(sql`${shippingMethods.deletedAt} IS NOT NULL`);
        } else {
            whereConditions.push(sql`${shippingMethods.deletedAt} IS NULL`);
        }

        if (search) {
            whereConditions.push(
                or(
                    like(shippingMethods.name, `%${search}%`),
                    like(shippingMethods.description, `%${search}%`),
                ),
            );
        }

        const combinedWhereClause =
            whereConditions.length > 0 ? and(...whereConditions) : undefined;

        const results = await db
            .select()
            .from(shippingMethods)
            .where(combinedWhereClause)
            .orderBy(
                sortOrder === "asc"
                    ? asc(shippingMethods[sortField as keyof typeof shippingMethods._.columns])
                    : desc(shippingMethods[sortField as keyof typeof shippingMethods._.columns]),
            )
            .limit(limit)
            .offset(offset);

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(shippingMethods)
            .where(combinedWhereClause)
            .get();

        const total = countResult?.count || 0;
        const totalPages = Math.ceil(total / limit);

        return c.json({
            data: results,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
        }, 200);
    } catch (error) {
        console.error("Error fetching shipping methods:", error);
        return c.json({ error: "Failed to fetch shipping methods" }, 500);
    }
});

// ── Create Shipping Method ──

const createRoute_ = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Shipping Methods"],
    summary: "Create a shipping method",
    request: {
        body: { content: { "application/json": { schema: createShippingMethodSchema } } },
    },
    responses: { 201: { description: "Shipping method created", content: { "application/json": { schema: z.any() } } } },
});

app.openapi(createRoute_, async (c) => {
    const db = c.get("db");
    try {
        const data = c.req.valid("json");
        const { name, fee, description, isActive, sortOrder } = data;

        const existingMethod = await db
            .select()
            .from(shippingMethods)
            .where(
                and(eq(shippingMethods.name, name), isNull(shippingMethods.deletedAt)),
            )
            .get();
        if (existingMethod) {
            return c.json({ error: "A shipping method with this name already exists." }, 409);
        }

        const newMethodId = "sm_" + nanoid();
        const [insertedMethod] = await db
            .insert(shippingMethods)
            .values({
                id: newMethodId,
                name,
                fee,
                description,
                isActive,
                sortOrder,
                createdAt: sql`(cast(strftime('%s','now') as int))`,
                updatedAt: sql`(cast(strftime('%s','now') as int))`,
            })
            .returning();

        return c.json({ data: insertedMethod }, 201);
    } catch (error: any) {
        console.error("Error creating shipping method:", error);
        if (error.message && error.message.includes("UNIQUE constraint failed")) {
            return c.json({ error: "A shipping method with this name already exists." }, 409);
        }
        return c.json({ error: "Failed to create shipping method" }, 500);
    }
});

// ── Get Shipping Method ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Get a shipping method by ID",
    request: { params: z.object({ id: z.string().openapi({ description: "Shipping method ID" }) }) },
    responses: { 200: { description: "Shipping method details", content: { "application/json": { schema: z.any() } } } },
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const method = await db
            .select()
            .from(shippingMethods)
            .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
            .get();

        if (!method) return c.json({ error: "Shipping method not found" }, 404);
        return c.json({ data: method }, 200);
    } catch (error) {
        console.error(`Error fetching shipping method ${id}:`, error);
        return c.json({ error: "Failed to fetch shipping method" }, 500);
    }
});

// ── Update Shipping Method ──

const updateRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Update a shipping method",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Shipping method ID" }) }),
        body: { content: { "application/json": { schema: updateShippingMethodSchema } } },
    },
    responses: { 200: { description: "Shipping method updated", content: { "application/json": { schema: z.any() } } } },
});

app.openapi(updateRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const data = c.req.valid("json");

        const currentMethod = await db
            .select()
            .from(shippingMethods)
            .where(eq(shippingMethods.id, id))
            .get();
        if (!currentMethod) {
            return c.json({ error: "Shipping method not found" }, 404);
        }

        if (data.name && data.name !== currentMethod.name) {
            const existingMethodWithName = await db
                .select()
                .from(shippingMethods)
                .where(
                    and(
                        eq(shippingMethods.name, data.name),
                        isNull(shippingMethods.deletedAt),
                        eq(shippingMethods.id, id),
                    ),
                )
                .get();
            if (existingMethodWithName) {
                return c.json({ error: "A shipping method with this name already exists." }, 409);
            }
        }

        const [updatedMethod] = await db
            .update(shippingMethods)
            .set({
                ...data,
                updatedAt: sql`(cast(strftime('%s','now') as int))`,
            })
            .where(eq(shippingMethods.id, id))
            .returning();

        if (!updatedMethod) {
            return c.json({ error: "Shipping method not found or no changes made" }, 404);
        }

        return c.json({ data: updatedMethod }, 200);
    } catch (error: any) {
        console.error(`Error updating shipping method ${id}:`, error);
        if (error.message && error.message.includes("UNIQUE constraint failed")) {
            return c.json({ error: "A shipping method with this name already exists." }, 409);
        }
        return c.json({ error: "Failed to update shipping method" }, 500);
    }
});

// ── Delete Shipping Method ──

const deleteRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Soft-delete a shipping method",
    request: { params: z.object({ id: z.string().openapi({ description: "Shipping method ID" }) }) },
    responses: { 204: { description: "Shipping method deleted" } },
});

app.openapi(deleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const existingMethod = await db
            .select({ id: shippingMethods.id })
            .from(shippingMethods)
            .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
            .get();

        if (!existingMethod) {
            return c.json({ error: "Shipping method not found or already deleted" }, 404);
        }

        await db
            .update(shippingMethods)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(shippingMethods.id, id));

        return new Response(null, { status: 204 }) as any;
    } catch (error) {
        console.error(`Error deleting shipping method ${id}:`, error);
        return c.json({ error: "Failed to delete shipping method" }, 500);
    }
});

// ── Restore Shipping Method ──

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Shipping Methods"],
    summary: "Restore a soft-deleted shipping method",
    request: { params: z.object({ id: z.string().openapi({ description: "Shipping method ID" }) }) },
    responses: { 200: { description: "Shipping method restored", content: { "application/json": { schema: z.any() } } } },
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const methodToRestore = await db
            .select({
                id: shippingMethods.id,
                deletedAt: shippingMethods.deletedAt,
            })
            .from(shippingMethods)
            .where(
                and(
                    eq(shippingMethods.id, id),
                    sql`${shippingMethods.deletedAt} IS NOT NULL`,
                ),
            )
            .get();

        if (!methodToRestore) {
            return c.json({ error: "Shipping method not found or not deleted" }, 404);
        }

        await db
            .update(shippingMethods)
            .set({
                deletedAt: null,
                updatedAt: sql`(cast(strftime('%s','now') as int))`,
            })
            .where(eq(shippingMethods.id, id));

        return c.json({ message: "Shipping method restored successfully" }, 200);
    } catch (error) {
        console.error(`Error restoring shipping method ${id}:`, error);
        return c.json({ error: "Failed to restore shipping method" }, 500);
    }
});

// ── Permanent Delete Shipping Method ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent-delete",
    tags: ["Admin - Shipping Methods"],
    summary: "Permanently delete a shipping method",
    request: { params: z.object({ id: z.string().openapi({ description: "Shipping method ID" }) }) },
    responses: { 204: { description: "Shipping method permanently deleted" } },
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const existingMethod = await db
            .select({ id: shippingMethods.id, deletedAt: shippingMethods.deletedAt })
            .from(shippingMethods)
            .where(eq(shippingMethods.id, id))
            .get();

        if (!existingMethod) {
            return c.json({ error: "Shipping method not found" }, 404);
        }

        await db.delete(shippingMethods).where(eq(shippingMethods.id, id));

        return new Response(null, { status: 204 }) as any;
    } catch (error) {
        console.error(`Error permanently deleting shipping method ${id}:`, error);
        return c.json({ error: "Failed to permanently delete shipping method" }, 500);
    }
});

export { app as shippingMethodsSettingsRoutes };
