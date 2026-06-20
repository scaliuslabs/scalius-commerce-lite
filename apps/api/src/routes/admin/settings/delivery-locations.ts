import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { deliveryLocations } from "@scalius/database/schema";
import { eq, and, isNull, like, sql, inArray } from "drizzle-orm";
import { createLocation, getLocationById } from "@scalius/core/modules/delivery/locations";
import { getCheckoutReadiness } from "@scalius/core/modules/settings/checkout-readiness";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { getEncryptionKey } from "../../../utils/encryption-key";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, paginatedEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";
const app = new OpenAPIHono<{ Bindings: Env }>();
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const CHECKOUT_BREAKING_LOCATION_MESSAGE =
    "This change would make checkout unavailable. Keep at least one active city with an active zone.";
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

async function assertDeliveryLocationsCanBeRemovedFromCheckout(
    db: Parameters<typeof getCheckoutReadiness>[0],
    ids: readonly string[],
) {
    const [currentReadiness, nextReadiness] = await Promise.all([
        getCheckoutReadiness(db),
        getCheckoutReadiness(db, { excludeDeliveryLocationIds: ids }),
    ]);
    if (currentReadiness.ready && !nextReadiness.ready) {
        throw new ValidationError([CHECKOUT_BREAKING_LOCATION_MESSAGE, ...nextReadiness.issues].join(" "));
    }
}

async function assertAllDeliveryLocationsCanBeRemovedFromCheckout(
    db: Parameters<typeof getCheckoutReadiness>[0],
) {
    const currentReadiness = await getCheckoutReadiness(db);
    if (currentReadiness.ready) {
        throw new ValidationError([
            CHECKOUT_BREAKING_LOCATION_MESSAGE,
            "Deleting all delivery locations would remove every active city and zone.",
        ].join(" "));
    }
}

async function isActiveCity(db: Parameters<typeof getCheckoutReadiness>[0], id: string | null | undefined) {
    if (!id) return false;
    const row = await db
        .select({ id: deliveryLocations.id })
        .from(deliveryLocations)
        .where(and(
            eq(deliveryLocations.id, id),
            eq(deliveryLocations.type, "city"),
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
        ))
        .get();
    return !!row;
}

const parseJsonObject = (value: string | null): Record<string, unknown> => {
    try {
        return value ? JSON.parse(value) as Record<string, unknown> : {};
    } catch {
        return {};
    }
};

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

const deliveryLocationSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["city", "zone", "area"]),
    parentId: z.string().nullable(),
    externalIds: z.record(z.string(), z.unknown()).nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    displayName: z.string().optional(),
}).passthrough();

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
            limit: z.coerce.number().max(500).default(100).openapi({ description: "Items per page" })
        })
    },
    responses: {
        200: { description: "Location list", content: { "application/json": { schema: paginatedEnvelope("locations", deliveryLocationSchema) } } },
        ...errorResponses,
    }
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

        const conditions = [isNull(deliveryLocations.deletedAt)];

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

        const formattedLocations = locations.map((location) => {
            const externalIds = parseJsonObject(location.externalIds);
            const metadata = parseJsonObject(location.metadata);
            return {
                ...location,
                externalIds,
                metadata,
                displayName: `${location.name}`
            };
        });

        return ok(c, {
            locations: formattedLocations,
            pagination: {
                total: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error: unknown) {
        console.error("Error fetching delivery locations:", error);
        throw error;
    }
});

// ── Create Location ──

const createLocationRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Delivery Locations"],
    summary: "Create a delivery location",
    request: { body: { content: { "application/json": { schema: locationSchema } } } },
    responses: {
        201: { description: "Location created", content: { "application/json": { schema: successEnvelope(z.object({ location: deliveryLocationSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(createLocationRoute, (async (c) => {
    try {
        const db = c.get("db");
        const data = c.req.valid("json");
        const newLocation = await createLocation(db, data);
        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return created(c, { location: newLocation });
    } catch (error: unknown) {
        console.error("Error creating delivery location:", error);
        throw error;
    }
}) as AppRouteHandler<typeof createLocationRoute>);

// ── Delete All Locations ──

const deleteAllRoute = createRoute({
    method: "delete",
    path: "/all",
    tags: ["Admin - Delivery Locations"],
    summary: "Delete all delivery locations permanently",
    request: {
        body: { content: { "application/json": { schema: z.object({ confirmDeleteAll: z.literal(true) }) } } }
    },
    responses: {
        200: { description: "All locations deleted", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(deleteAllRoute, async (c) => {
    const { confirmDeleteAll } = c.req.valid("json");
    if (!confirmDeleteAll) {
        throw new ValidationError("Must confirm deletion by setting confirmDeleteAll: true");
    }
    const db = c.get("db");
    await assertAllDeliveryLocationsCanBeRemovedFromCheckout(db);
    await db.delete(deliveryLocations);
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
    return ok(c, { message: "All delivery locations have been permanently deleted." });
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
    responses: {
        200: { description: "Locations deleted", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    try {
        const db = c.get("db");
        const { ids } = c.req.valid("json");
        if (ids.length === 0) throw new ValidationError("An array of location IDs is required");

        await assertDeliveryLocationsCanBeRemovedFromCheckout(db, ids);

        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(inArray(deliveryLocations.id, ids), isNull(deliveryLocations.deletedAt)));

        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, { message: `${ids.length} locations deleted successfully.` });
    } catch (error: unknown) {
        console.error("Error bulk deleting delivery locations:", error);
        throw error;
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
    responses: {
        200: { description: "Location details", content: { "application/json": { schema: successEnvelope(deliveryLocationSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const db = c.get("db");
        const location = await getLocationById(db, id);
        if (!location) throw new NotFoundError("Location not found");
        return ok(c, location);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        console.error("Error fetching delivery location:", error);
        throw error;
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
    responses: {
        200: { description: "Location updated", content: { "application/json": { schema: successEnvelope(deliveryLocationSchema) } } },
        ...errorResponses,
    }
});

app.openapi(updateLocationRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const parsedData = c.req.valid("json");
        const currentLocation = await db
            .select({
                id: deliveryLocations.id,
                type: deliveryLocations.type,
                parentId: deliveryLocations.parentId,
                isActive: deliveryLocations.isActive,
            })
            .from(deliveryLocations)
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)))
            .get();

        if (!currentLocation) throw new NotFoundError("Location not found");

        const removesCurrentLocationFromReadiness =
            currentLocation.isActive &&
            (parsedData.isActive === false ||
                (currentLocation.type === "zone" &&
                    parsedData.parentId !== undefined &&
                    !(await isActiveCity(db, parsedData.parentId))));
        if (removesCurrentLocationFromReadiness) {
            await assertDeliveryLocationsCanBeRemovedFromCheckout(db, [id]);
        }

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

        const externalIds = parseJsonObject(updatedLocation.externalIds);
        const metadata = parseJsonObject(updatedLocation.metadata);
        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, {
            ...updatedLocation,
            externalIds,
            metadata
        });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        console.error("Error updating location:", error);
        throw error;
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
    responses: {
        200: { description: "Location deleted", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(deleteLocationRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const currentLocation = await db
            .select({
                id: deliveryLocations.id,
                type: deliveryLocations.type,
                isActive: deliveryLocations.isActive,
            })
            .from(deliveryLocations)
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)))
            .get();

        if (!currentLocation) throw new NotFoundError("Location not found");
        if (currentLocation.isActive && (currentLocation.type === "city" || currentLocation.type === "zone")) {
            await assertDeliveryLocationsCanBeRemovedFromCheckout(db, [id]);
        }

        await db
            .update(deliveryLocations)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)));
        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, {});
    } catch (error: unknown) {
        console.error("Error deleting location:", error);
        throw error;
    }
});

// ── Pathao Location Import ──────────────────────────────────────────────────

import {
    processPathaoImportChunk,
    resetPathaoImportProgress,
    getPathaoImportStatus,
} from "@scalius/core/modules/delivery/pathao-location-import";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import { deliveryProviders } from "@scalius/database/schema";

/**
 * POST /import-pathao — Process one chunk of Pathao location import.
 * Call repeatedly until status === "complete".
 * Admin UI drives the loop with a progress bar.
 */
app.post("/import-pathao", async (c) => {
    const db = c.get("db");
    const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;

    if (!kv) {
        throw new ValidationError("KV namespace not available");
    }

    // Find active Pathao provider to get credentials
    const provider = await db
        .select()
        .from(deliveryProviders)
        .where(and(eq(deliveryProviders.type, "pathao"), eq(deliveryProviders.isActive, true)))
        .get();

    if (!provider) {
        throw new ValidationError("No active Pathao provider configured. Add one in Delivery Provider settings first.");
    }

    let creds: { baseUrl: string; clientId: string; clientSecret: string; username: string; password: string };
    try {
        const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
        const rawCreds = await decryptCredentialsGraceful(provider.credentials, encryptionKey);
        creds = JSON.parse(rawCreds);
    } catch {
        throw new ValidationError("Invalid Pathao credentials. Check your provider settings.");
    }

    if (!creds.baseUrl || !creds.clientId || !creds.clientSecret || !creds.username || !creds.password) {
        throw new ValidationError("Incomplete Pathao credentials. Ensure baseUrl, clientId, clientSecret, username, and password are configured.");
    }

    const result = await processPathaoImportChunk(db, kv, creds);
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
    return ok(c, result);
});

/**
 * GET /import-pathao/status — Check current import progress without processing.
 */
app.get("/import-pathao/status", async (c) => {
    const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
    if (!kv) throw new ValidationError("KV not available");

    const status = await getPathaoImportStatus(kv);
    return ok(c, status);
});

/**
 * DELETE /import-pathao — Reset import progress (for retrying or re-importing).
 */
app.delete("/import-pathao", async (c) => {
    const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
    if (!kv) throw new ValidationError("KV not available");

    await resetPathaoImportProgress(kv);
    return ok(c, { message: "Import progress reset. You can start a fresh import." });
});

export { app as adminLocationRoutes };
