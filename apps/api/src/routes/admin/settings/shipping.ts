import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { sql, eq, and, or, isNull, like, asc, desc } from "drizzle-orm";
import { shippingMethods } from "@scalius/database/schema";
import { getCheckoutReadiness } from "@scalius/core/modules/settings/checkout-readiness";
import { NotFoundError, ConflictError, ValidationError } from "../../../utils/api-error";

import { ok, created, noContent } from "../../../utils/api-response";
import { successEnvelope, paginatedEnvelope, messageResponse, noContentResponse, errorResponses } from "../../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const CHECKOUT_BREAKING_SHIPPING_MESSAGE =
    "This change would make checkout unavailable. Keep at least one active shipping method.";
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AppRouteContext<R extends RouteConfig> = Parameters<AppRouteHandler<R>>[0];

async function assertShippingMethodCanBeRemovedFromCheckout(
    db: Parameters<typeof getCheckoutReadiness>[0],
    id: string,
) {
    const [currentReadiness, nextReadiness] = await Promise.all([
        getCheckoutReadiness(db),
        getCheckoutReadiness(db, { excludeShippingMethodIds: [id] }),
    ]);
    if (currentReadiness.ready && !nextReadiness.ready) {
        throw new ValidationError([CHECKOUT_BREAKING_SHIPPING_MESSAGE, ...nextReadiness.issues].join(" "));
    }
}

const createShippingMethodSchema = z.object({
    name: z.string().min(1, "Name is required").max(100),
    fee: z.number().min(0, "Fee must be a positive number"),
    description: z.string().max(255).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().optional().default(0)
});

const updateShippingMethodSchema = z.object({
    name: z.string().min(1, "Name is required").max(100).optional(),
    fee: z.number().min(0, "Fee must be a positive number").optional(),
    description: z.string().max(255).optional().nullable(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional()
});

// ── List Shipping Methods ──

const shippingMethodSchema = z.object({
    id: z.string(),
    name: z.string(),
    fee: z.number(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
}).passthrough();

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Shipping Methods"],
    summary: "List all shipping methods",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.string().optional().default("sortOrder").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" })
        })
    },
    responses: {
        200: { description: "Shipping method list", content: { "application/json": { schema: paginatedEnvelope("shippingMethods", shippingMethodSchema) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    try {
        const query = c.req.valid("query");
        const page = query.page;
        const limit = query.limit;
        const search = query.search || "";
        const sortField = (query.sort || "sortOrder") as string;
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

        return ok(c, {
            shippingMethods: results,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        });
    } catch (error: unknown) {
        console.error("Error fetching shipping methods:", error);
        throw error;
    }
});

// ── Create Shipping Method ──

const createRoute_ = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Shipping Methods"],
    summary: "Create a shipping method",
    request: {
        body: { content: { "application/json": { schema: createShippingMethodSchema } } }
    },
    responses: {
        201: { description: "Shipping method created", content: { "application/json": { schema: successEnvelope(z.object({ shippingMethod: shippingMethodSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(createRoute_, (async (c: AppRouteContext<typeof createRoute_>) => {
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
            throw new ConflictError("A shipping method with this name already exists.");
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
                updatedAt: sql`(cast(strftime('%s','now') as int))`
            })
            .returning();

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return created(c, { shippingMethod: insertedMethod });
    } catch (error: unknown) {
        console.error("Error creating shipping method:", error);
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
            throw new ConflictError("A shipping method with this name already exists.");
        }
        throw error;
    }
}) as unknown as AppRouteHandler<typeof createRoute_>);

// ── Get Shipping Method ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Get a shipping method by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Shipping method details", content: { "application/json": { schema: successEnvelope(z.object({ shippingMethod: shippingMethodSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, (async (c: AppRouteContext<typeof getByIdRoute>) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const method = await db
            .select()
            .from(shippingMethods)
            .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
            .get();

        if (!method) throw new NotFoundError("Shipping method not found");
        return ok(c, { shippingMethod: method });
    } catch (error: unknown) {
        console.error(`Error fetching shipping method ${id}:`, error);
        throw error;
    }
}) as unknown as AppRouteHandler<typeof getByIdRoute>);

// ── Update Shipping Method ──

const updateRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Update a shipping method",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateShippingMethodSchema } } }
    },
    responses: {
        200: { description: "Shipping method updated", content: { "application/json": { schema: successEnvelope(z.object({ shippingMethod: shippingMethodSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(updateRoute, (async (c: AppRouteContext<typeof updateRoute>) => {
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
            throw new NotFoundError("Shipping method not found");
        }

        if (currentMethod.isActive && currentMethod.deletedAt === null && data.isActive === false) {
            await assertShippingMethodCanBeRemovedFromCheckout(db, id);
        }

        if (data.name && data.name !== currentMethod.name) {
            const existingMethodWithName = await db
                .select()
                .from(shippingMethods)
                .where(
                    and(
                        eq(shippingMethods.name, data.name),
                        sql`${shippingMethods.id} != ${id}`,
                        isNull(shippingMethods.deletedAt),
                    ),
                )
                .get();
            if (existingMethodWithName) {
                throw new ConflictError("A shipping method with this name already exists.");
            }
        }

        const [updatedMethod] = await db
            .update(shippingMethods)
            .set({
                ...data,
                updatedAt: sql`(cast(strftime('%s','now') as int))`
            })
            .where(eq(shippingMethods.id, id))
            .returning();

        if (!updatedMethod) {
            throw new NotFoundError("Shipping method not found or no changes made");
        }

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, { shippingMethod: updatedMethod });
    } catch (error: unknown) {
        console.error(`Error updating shipping method ${id}:`, error);
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
            throw new ConflictError("A shipping method with this name already exists.");
        }
        throw error;
    }
}) as unknown as AppRouteHandler<typeof updateRoute>);

// ── Delete Shipping Method ──

const deleteRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Shipping Methods"],
    summary: "Soft-delete a shipping method",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        404: errorResponses[404],
    }
});

app.openapi(deleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const existingMethod = await db
            .select({
                id: shippingMethods.id,
                isActive: shippingMethods.isActive,
            })
            .from(shippingMethods)
            .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
            .get();

        if (!existingMethod) {
            throw new NotFoundError("Shipping method not found or already deleted");
        }

        if (existingMethod.isActive) {
            await assertShippingMethodCanBeRemovedFromCheckout(db, id);
        }

        await db
            .update(shippingMethods)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(shippingMethods.id, id));

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return noContent(c);
    } catch (error: unknown) {
        console.error(`Error deleting shipping method ${id}:`, error);
        throw error;
    }
});

// ── Restore Shipping Method ──

const restoreRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Shipping Methods"],
    summary: "Restore a soft-deleted shipping method",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Shipping method restored", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(restoreRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const methodToRestore = await db
            .select({
                id: shippingMethods.id,
                deletedAt: shippingMethods.deletedAt
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
            throw new NotFoundError("Shipping method not found or not deleted");
        }

        await db
            .update(shippingMethods)
            .set({
                deletedAt: null,
                updatedAt: sql`(cast(strftime('%s','now') as int))`
            })
            .where(eq(shippingMethods.id, id));

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, { message: "Shipping method restored successfully" });
    } catch (error: unknown) {
        console.error(`Error restoring shipping method ${id}:`, error);
        throw error;
    }
});

// ── Permanent Delete Shipping Method ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent-delete",
    tags: ["Admin - Shipping Methods"],
    summary: "Permanently delete a shipping method",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        404: errorResponses[404],
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const existingMethod = await db
            .select({
                id: shippingMethods.id,
                isActive: shippingMethods.isActive,
                deletedAt: shippingMethods.deletedAt,
            })
            .from(shippingMethods)
            .where(eq(shippingMethods.id, id))
            .get();

        if (!existingMethod) {
            throw new NotFoundError("Shipping method not found");
        }

        if (existingMethod.isActive && existingMethod.deletedAt === null) {
            await assertShippingMethodCanBeRemovedFromCheckout(db, id);
        }

        await db.delete(shippingMethods).where(eq(shippingMethods.id, id));

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return noContent(c);
    } catch (error: unknown) {
        console.error(`Error permanently deleting shipping method ${id}:`, error);
        throw error;
    }
});

export { app as shippingMethodsSettingsRoutes };
