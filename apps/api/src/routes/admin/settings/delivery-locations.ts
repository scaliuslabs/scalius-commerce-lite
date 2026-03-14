import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deliveryLocations } from "@scalius/database/schema";
import { eq, and, isNull, like, sql, inArray } from "drizzle-orm";
import { createLocation, getLocationById } from "@scalius/core/modules/delivery/locations";
import { NotFoundError } from "../../../utils/api-error";

import { ok, created } from "../../../utils/api-response";
const app = new OpenAPIHono();

const locationSchema = z.object({
    name: z.string().min(1, "Name is required"),
    type: z.enum(["city", "zone", "area"]),
    parentId: z.string().nullish(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional().default({}),
    metadata: z.record(z.string(), z.string()).optional().default({}),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().optional().default(0)
});

const updateLocationSchema = z.object({
    name: z.string().min(1, "Name is required").optional(),
    parentId: z.string().nullish().optional(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional()
});

// ── List Locations ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Delivery Locations"],
    summary: "List delivery locations",
    request: {
        query: z.object({
            type: z.string().optional().openapi({ description: "Location type filter" }),
            parentId: z.string().optional().openapi({ description: "Parent ID filter" }),
            search: z.string().optional().openapi({ description: "Search term" }),
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(100).openapi({ description: "Items per page" })
        })
    },
    responses: { 200: { description: "Location list"  } }
});

app.openapi(listRoute, async (c) => {
    try {
        const db = c.get("db");
        const query = c.req.valid("query");
        const type = query.type as "city" | "zone" | "area" | undefined;
        const parentId = query.parentId;
        const search = query.search;
        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;

        let conditions = [isNull(deliveryLocations.deletedAt)];

        if (type) conditions.push(eq(deliveryLocations.type, type));
        if (parentId) conditions.push(eq(deliveryLocations.parentId, parentId));
        if (search && search.trim() !== "") {
            conditions.push(like(deliveryLocations.name, `%${search.trim()}%`));
        }

        const locations = await db
            .select()
            .from(deliveryLocations)
            .where(and(...conditions))
            .orderBy(deliveryLocations.sortOrder)
            .limit(limit)
            .offset(offset);

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(deliveryLocations)
            .where(and(...conditions))
            .get();
        const totalCount = countResult?.count || 0;

        const formattedLocations = locations.map((location) => ({
            ...location,
            externalIds: location.externalIds ? JSON.parse(location.externalIds) : {},
            metadata: location.metadata ? JSON.parse(location.metadata) : {},
            displayName: `${location.name}`
        }));

        return ok(c, {
            data: formattedLocations,
            pagination: {
                total: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error: unknown) {
        console.error("Error fetching delivery locations:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to fetch delivery locations" }, 500);
    }
});

// ── Create Location ──

const createLocationRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Delivery Locations"],
    summary: "Create a delivery location",
    request: { body: { content: { "application/json": { schema: locationSchema } } } },
    responses: { 201: { description: "Location created"  } }
});

app.openapi(createLocationRoute, async (c) => {
    try {
        const data = c.req.valid("json");
        const newLocation = await createLocation(data);
        return created(c, { data: newLocation });
    } catch (error: unknown) {
        console.error("Error creating delivery location:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to create delivery location" }, 500);
    }
});

// ── Delete All Locations ──

const deleteAllRoute = createRoute({
    method: "delete",
    path: "/all",
    tags: ["Admin - Delivery Locations"],
    summary: "Delete all delivery locations permanently",
    responses: { 200: { description: "All locations deleted"  } }
});

app.openapi(deleteAllRoute, async (c) => {
    try {
        const db = c.get("db");
        await db.delete(deliveryLocations);
        return ok(c, { success: true, message: "All delivery locations have been permanently deleted." });
    } catch (error: unknown) {
        console.error("Error cleaning all delivery locations:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to clean all delivery locations" }, 500);
    }
});

// ── Bulk Delete Locations ──

const bulkDeleteRoute = createRoute({
    method: "delete",
    path: "/",
    tags: ["Admin - Delivery Locations"],
    summary: "Bulk soft-delete delivery locations",
    request: {
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()) }) } } }
    },
    responses: { 200: { description: "Locations deleted"  } }
});

app.openapi(bulkDeleteRoute, async (c) => {
    try {
        const db = c.get("db");
        const { ids } = c.req.valid("json");
        if (ids.length === 0) return c.json({ error: "An array of location IDs is required" }, 400);

        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(inArray(deliveryLocations.id, ids), isNull(deliveryLocations.deletedAt)));

        return ok(c, { success: true, message: `${ids.length} locations deleted successfully.` });
    } catch (error: unknown) {
        console.error("Error bulk deleting delivery locations:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to bulk delete delivery locations" }, 500);
    }
});

// ── Get Location By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Delivery Locations"],
    summary: "Get a delivery location by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: { 200: { description: "Location details"  } }
});

app.openapi(getByIdRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const location = await getLocationById(id);
        if (!location) throw new NotFoundError("Location not found");
        return ok(c, location);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        console.error("Error fetching delivery location:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to fetch delivery location" }, 500);
    }
});

// ── Update Location ──

const updateLocationRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Delivery Locations"],
    summary: "Update a delivery location",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateLocationSchema } } }
    },
    responses: { 200: { description: "Location updated"  } }
});

app.openapi(updateLocationRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const parsedData = c.req.valid("json");

        const updateData: Record<string, unknown> = { updatedAt: sql`(cast(strftime('%s','now') as int))` };
        if (parsedData.name !== undefined) updateData.name = parsedData.name;
        if (parsedData.parentId !== undefined) updateData.parentId = parsedData.parentId;
        if (parsedData.externalIds !== undefined) updateData.externalIds = JSON.stringify(parsedData.externalIds);
        if (parsedData.metadata !== undefined) updateData.metadata = JSON.stringify(parsedData.metadata);
        if (parsedData.isActive !== undefined) updateData.isActive = parsedData.isActive;
        if (parsedData.sortOrder !== undefined) updateData.sortOrder = parsedData.sortOrder;

        const [updatedLocation] = await db
            .update(deliveryLocations)
            .set(updateData)
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)))
            .returning();

        if (!updatedLocation) throw new NotFoundError("Location not found");

        return ok(c, {
            ...updatedLocation,
            externalIds: updatedLocation.externalIds ? JSON.parse(updatedLocation.externalIds) : {},
            metadata: updatedLocation.metadata ? JSON.parse(updatedLocation.metadata) : {}
        });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        console.error("Error updating location:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to update location" }, 500);
    }
});

// ── Delete Location ──

const deleteLocationRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Delivery Locations"],
    summary: "Soft-delete a delivery location",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: { 200: { description: "Location deleted"  } }
});

app.openapi(deleteLocationRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)));
        return ok(c, { success: true });
    } catch (error: unknown) {
        console.error("Error deleting location:", error);
        return c.json({ error: error instanceof Error ? error.message : "Failed to delete location" }, 500);
    }
});

export { app as adminLocationRoutes };
