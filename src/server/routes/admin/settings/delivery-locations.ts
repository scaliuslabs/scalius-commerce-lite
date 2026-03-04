import { Hono } from "hono";
import { deliveryLocations } from "@/db/schema";
import { eq, and, isNull, like, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createLocation, getLocationById } from "@/modules/delivery/locations";

const app = new Hono<{ Bindings: Env }>();

const locationSchema = z.object({
    name: z.string().min(1, "Name is required"),
    type: z.enum(["city", "zone", "area"]),
    parentId: z.string().nullish(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional().default({}),
    metadata: z.record(z.string(), z.any()).optional().default({}),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().optional().default(0),
});

const updateLocationSchema = z.object({
    name: z.string().min(1, "Name is required").optional(),
    parentId: z.string().nullish().optional(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
});

app.get("/", async (c) => {
    try {
        const db = c.get("db");
        const type = c.req.query("type") as "city" | "zone" | "area" | undefined;
        const parentId = c.req.query("parentId");
        const search = c.req.query("search");
        const page = parseInt(c.req.query("page") || "1");
        const limit = parseInt(c.req.query("limit") || "100");
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
            displayName: `${location.name}`,
        }));

        return c.json({
            data: formattedLocations,
            pagination: {
                total: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit),
            },
        });
    } catch (error: any) {
        console.error("Error fetching delivery locations:", error);
        return c.json({ error: error.message || "Failed to fetch delivery locations" }, 500);
    }
});

app.post("/", zValidator("json", locationSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        const newLocation = await createLocation(data);
        return c.json({ data: newLocation }, 201);
    } catch (error: any) {
        console.error("Error creating delivery location:", error);
        return c.json({ error: error.message || "Failed to create delivery location" }, 500);
    }
});

app.delete("/all", async (c) => {
    try {
        const db = c.get("db");
        await db.delete(deliveryLocations);
        return c.json({ success: true, message: "All delivery locations have been permanently deleted." });
    } catch (error: any) {
        console.error("Error cleaning all delivery locations:", error);
        return c.json({ error: error.message || "Failed to clean all delivery locations" }, 500);
    }
});

app.delete("/", zValidator("json", z.object({ ids: z.array(z.string()) })), async (c) => {
    try {
        const db = c.get("db");
        const { ids } = c.req.valid("json");
        if (ids.length === 0) return c.json({ error: "An array of location IDs is required" }, 400);

        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(inArray(deliveryLocations.id, ids), isNull(deliveryLocations.deletedAt)));

        return c.json({ success: true, message: `${ids.length} locations deleted successfully.` });
    } catch (error: any) {
        console.error("Error bulk deleting delivery locations:", error);
        return c.json({ error: error.message || "Failed to bulk delete delivery locations" }, 500);
    }
});

app.get("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        const location = await getLocationById(id);
        if (!location) return c.json({ error: "Location not found" }, 404);
        return c.json(location);
    } catch (error: any) {
        console.error("Error fetching delivery location:", error);
        return c.json({ error: error.message || "Failed to fetch delivery location" }, 500);
    }
});

app.put("/:id", zValidator("json", updateLocationSchema), async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");
        const parsedData = c.req.valid("json");

        const updateData: any = { updatedAt: sql`(cast(strftime('%s','now') as int))` };
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

        if (!updatedLocation) return c.json({ error: "Location not found" }, 404);

        return c.json({
            ...updatedLocation,
            externalIds: updatedLocation.externalIds ? JSON.parse(updatedLocation.externalIds) : {},
            metadata: updatedLocation.metadata ? JSON.parse(updatedLocation.metadata) : {},
        });
    } catch (error: any) {
        console.error("Error updating location:", error);
        return c.json({ error: error.message || "Failed to update location" }, 500);
    }
});

app.delete("/:id", async (c) => {
    try {
        const db = c.get("db");
        const id = c.req.param("id");
        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)));
        return c.json({ success: true });
    } catch (error: any) {
        console.error("Error deleting location:", error);
        return c.json({ error: error.message || "Failed to delete location" }, 500);
    }
});

export { app as adminLocationRoutes };
