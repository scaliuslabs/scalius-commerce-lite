import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { deliveryProviders, places } from "@scalius/database/schema";
import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
    countPlaceDescendants,
    createPlace,
    deletePlaces,
    getPlaceById,
    importPlaces,
    listPlaceCountries,
    parseJsonObject,
    updatePlace,
    processPathaoImportChunk,
    resetPathaoImportProgress,
    getPathaoImportStatus,
} from "@scalius/core/modules/delivery";
import { normalizeMarketCountry } from "@scalius/shared/markets";
import {
    PLACE_ADDRESS_COUNTRY,
    PLACE_IMPORT_MAX_ENTRIES,
    PLACE_MAX_LEVEL,
    placeLevelName,
    placeLevels,
} from "@scalius/shared/places";
import { isReady, readinessMessages } from "@scalius/shared/readiness";
import { getCheckoutDeliveryReadiness } from "@scalius/core/modules/checkout";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, paginatedEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const CHECKOUT_BREAKING_LOCATION_MESSAGE =
    "This change would make checkout unavailable. Keep at least one active city with an active thana.";
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

async function assertDeliveryLocationsCanBeRemovedFromCheckout(
    db: Parameters<typeof getCheckoutDeliveryReadiness>[0],
    ids: readonly string[],
) {
    const [currentReadiness, nextReadiness] = await Promise.all([
        getCheckoutDeliveryReadiness(db),
        getCheckoutDeliveryReadiness(db, { excludeDeliveryLocationIds: ids }),
    ]);
    if (isReady(currentReadiness) && !isReady(nextReadiness)) {
        throw new ValidationError([CHECKOUT_BREAKING_LOCATION_MESSAGE, ...readinessMessages(nextReadiness)].join(" "));
    }
}

async function assertAllDeliveryLocationsCanBeRemovedFromCheckout(
    db: Parameters<typeof getCheckoutDeliveryReadiness>[0],
) {
    const currentReadiness = await getCheckoutDeliveryReadiness(db);
    if (isReady(currentReadiness)) {
        throw new ValidationError([
            CHECKOUT_BREAKING_LOCATION_MESSAGE,
            "Deleting all delivery locations would remove every active city and thana.",
        ].join(" "));
    }
}

/** A level's name in an API message ("thana"). */
const levelWord = (countryCode: string, level: number) => placeLevelName(countryCode, level, "en").toLowerCase();

function countryOf(value: string): string {
    const country = normalizeMarketCountry(value);
    if (!country) throw new ValidationError("Use an ISO 3166-1 alpha-2 country code.");
    return country;
}

function assertLevel(countryCode: string, level: number) {
    const depth = placeLevels(countryCode).length;
    if (level < 1 || level > depth) {
        throw new ValidationError(`A ${countryCode} place has a level from 1 to ${depth}.`);
    }
}

async function assertValidLocationParent(
    db: Parameters<typeof getCheckoutDeliveryReadiness>[0],
    countryCode: string,
    level: number,
    parentId: string | null | undefined,
    isActive: boolean,
) {
    if (level === 1) {
        if (parentId) throw new ValidationError(`A ${levelWord(countryCode, 1)} cannot have a parent location.`);
        return;
    }

    const parentWord = levelWord(countryCode, level - 1);
    if (!parentId) {
        throw new ValidationError(`Select a parent ${parentWord}.`);
    }

    const parent = await db
        .select({ id: places.id, isActive: places.isActive })
        .from(places)
        .where(and(
            eq(places.id, parentId),
            eq(places.countryCode, countryCode),
            eq(places.level, level - 1),
            isNull(places.deletedAt),
        ))
        .get();

    if (!parent) {
        throw new ValidationError(`Select an existing ${parentWord}.`);
    }
    if (isActive && !parent.isActive) {
        throw new ValidationError(`Activate the parent ${parentWord} before activating this ${levelWord(countryCode, level)}.`);
    }
}

async function assertActiveLocationIdentityAvailable(
    db: Parameters<typeof getCheckoutDeliveryReadiness>[0],
    countryCode: string,
    level: number,
    parentId: string | null | undefined,
    name: string,
    isActive: boolean,
    currentId?: string,
) {
    if (!isActive) return;

    const parentCondition = parentId
        ? eq(places.parentId, parentId)
        : isNull(places.parentId);
    const existing = await db
        .select({ id: places.id })
        .from(places)
        .where(and(
            eq(places.countryCode, countryCode),
            eq(places.level, level),
            parentCondition,
            eq(places.isActive, true),
            isNull(places.deletedAt),
            sql`lower(trim(${places.name})) = lower(trim(${name}))`,
        ))
        .get();

    if (existing && existing.id !== currentId) {
        throw new ValidationError(
            `An active ${levelWord(countryCode, level)} named “${name}” already exists under this parent.`,
        );
    }
}

function rethrowDeliveryLocationIdentityConflict(error: unknown): never {
    if (
        error instanceof Error &&
        /places_active_(?:root|child)_name_uidx|UNIQUE constraint failed:\s*places/i.test(
            error.message,
        )
    ) {
        throw new ValidationError(
            "An active location with this name already exists under the same parent.",
        );
    }
    throw error;
}

const countryCodeSchema = z.string().trim().regex(/^[A-Za-z]{2}$/, "Use an ISO 3166-1 alpha-2 country code.");
const levelSchema = z.number().int().min(1).max(PLACE_MAX_LEVEL);

const locationSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(120),
    countryCode: countryCodeSchema,
    level: levelSchema,
    parentId: z.string().trim().min(1).max(128).nullish(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional().default({}),
    metadata: z.record(z.string(), z.string()).optional().default({}),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(-100000).max(100000).optional().default(0)
});

const updateLocationSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(120).optional(),
    parentId: z.string().trim().min(1).max(128).nullish().optional(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(-100000).max(100000).optional()
});

// ── List Locations ──

const deliveryLocationSchema = z.object({
    id: z.string(),
    name: z.string(),
    countryCode: z.string(),
    level: z.number().int(),
    parentId: z.string().nullable(),
    /** The stable source key an import gave the place (`pathao:area:13193`); null for the merchant's own. */
    sourceKey: z.string().nullable(),
    /** The dataset that created the place (`bd`); null for the merchant's own. */
    source: z.string().nullable(),
    externalIds: z.record(z.string(), z.unknown()).nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    displayName: z.string().optional(),
    /** Names of the parents, nearest first: a thana's city; an area's thana then city. */
    parentPath: z.array(z.string()).optional(),
    /** Live places under it by level (`{ "2": 1, "3": 4 }`): what deleting it deletes too. */
    descendants: z.record(z.string(), z.number().int()).optional(),
}).passthrough();

type PlaceRow = Omit<typeof places.$inferSelect, "externalIds" | "metadata"> & {
    externalIds: string | Record<string, unknown>;
    metadata: string | Record<string, unknown>;
};
const jsonObject = (value: string | Record<string, unknown>) => (typeof value === "string" ? parseJsonObject(value) : value);

/** A place as the dashboard reads it: JSON columns parsed, no import bookkeeping beyond key and source. */
function formatPlace(place: PlaceRow) {
    return {
        id: place.id,
        name: place.name,
        countryCode: place.countryCode,
        level: place.level,
        parentId: place.parentId,
        sourceKey: place.sourceKey,
        source: place.source,
        externalIds: jsonObject(place.externalIds),
        metadata: jsonObject(place.metadata),
        isActive: place.isActive,
        sortOrder: place.sortOrder,
    };
}

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.delivery_locations.list",
    tags: ["Admin - Delivery Locations"],
    summary: "List places (delivery locations)",
    request: {
        query: z.object({
            country: countryCodeSchema.optional().openapi({ description: "ISO 3166-1 alpha-2 country of the places" }),
            level: z.coerce.number().int().min(1).max(PLACE_MAX_LEVEL).optional().openapi({ description: "Level filter: 1 is the top (Bangladesh: 1 city, 2 thana, 3 area)" }),
            parentId: z.string().trim().min(1).max(128).optional().openapi({ description: "Parent ID filter" }),
            id: z.string().trim().min(1).max(128).optional().openapi({ description: "One location by ID (to label a saved choice)" }),
            isActive: z.enum(["true", "false"]).optional().openapi({ description: "Only active (true) or inactive (false) locations" }),
            search: z.string().trim().max(120).optional().openapi({ description: "Search term: part of the name, any script; names starting with it come first" }),
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(500).default(100).openapi({ description: "Items per page" })
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
        const search = query.search;
        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;

        const conditions = [isNull(places.deletedAt)];

        // A child is in its parent's country: with a parent, its index alone reads them.
        if (query.country && !query.parentId) conditions.push(eq(places.countryCode, countryOf(query.country)));
        if (query.level) conditions.push(eq(places.level, query.level));
        if (query.parentId) conditions.push(eq(places.parentId, query.parentId));
        if (query.id) conditions.push(eq(places.id, query.id));
        if (query.isActive) conditions.push(eq(places.isActive, query.isActive === "true"));
        const term = search?.trim().toLocaleLowerCase() ?? "";
        const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
        if (term) {
            // lower() folds ASCII case; Bangla has no case, so it matches as typed.
            conditions.push(sql`lower(${places.name}) LIKE ${`%${escaped}%`} ESCAPE '\\'`);
        }

        const parent = alias(places, "parent_location");
        const grandparent = alias(places, "grandparent_location");
        const rows = await db
            .select({ location: places, parentName: parent.name, grandparentName: grandparent.name })
            .from(places)
            .leftJoin(parent, eq(parent.id, places.parentId))
            .leftJoin(grandparent, eq(grandparent.id, parent.parentId))
            .where(and(...conditions))
            .orderBy(
                ...(term
                    ? [sql`CASE WHEN lower(${places.name}) LIKE ${`${escaped}%`} ESCAPE '\\' THEN 0 ELSE 1 END`]
                    : []),
                asc(places.sortOrder),
                asc(places.name),
                asc(places.id),
            )
            .limit(limit)
            .offset(offset);
        const locations = rows.map((row) => row.location);
        const pathOf = new Map(rows.map((row) => [
            row.location.id,
            [row.parentName, row.grandparentName].filter((name): name is string => Boolean(name)),
        ]));

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(places)
            .where(and(...conditions))
            .get();
        const totalCount = countResult?.count || 0;
        // Places with levels under them; a country's top of four levels counts three down.
        const parents = locations.filter((location) => location.level < placeLevels(location.countryCode).length);
        const depth = parents.some((location) => placeLevels(location.countryCode).length - location.level >= 3) ? 3 : 2;
        const descendants = await countPlaceDescendants(db, parents.map((location) => location.id), depth);

        const formattedLocations = locations.map((location) => ({
            ...formatPlace(location),
            displayName: `${location.name}`,
            parentPath: pathOf.get(location.id) ?? [],
            ...(location.level < placeLevels(location.countryCode).length
                ? { descendants: descendants.get(location.id) ?? {} }
                : {}),
        }));

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

// ── Countries ──

const countriesRoute = createRoute({
    method: "get",
    path: "/countries",
    operationId: "dashboard.delivery_locations.countries",
    tags: ["Admin - Delivery Locations"],
    summary: "List the countries that have places",
    responses: {
        200: {
            description: "Countries with their live place counts",
            content: { "application/json": { schema: successEnvelope(z.object({
                countries: z.array(z.object({ countryCode: z.string(), places: z.number().int() })).max(250),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(countriesRoute, async (c) => {
    return ok(c, { countries: await listPlaceCountries(c.get("db")) });
});

// ── Create Location ──

const createLocationRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.delivery_locations.create",
    tags: ["Admin - Delivery Locations"],
    summary: "Create a place (delivery location)",
    request: { body: { required: true, content: { "application/json": { schema: locationSchema } } } },
    responses: {
        201: { description: "Location created", content: { "application/json": { schema: successEnvelope(z.object({ location: deliveryLocationSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(createLocationRoute, (async (c) => {
    try {
        const db = c.get("db");
        const data = c.req.valid("json");
        const countryCode = countryOf(data.countryCode);
        assertLevel(countryCode, data.level);
        await assertValidLocationParent(db, countryCode, data.level, data.parentId, data.isActive);
        await assertActiveLocationIdentityAvailable(
            db,
            countryCode,
            data.level,
            data.parentId,
            data.name,
            data.isActive,
        );
        const newLocation = await createPlace(db, { ...data, countryCode });
        if (!newLocation) throw new NotFoundError("Location not found");

        return created(c, { location: formatPlace(newLocation) });
    } catch (error: unknown) {
        rethrowDeliveryLocationIdentityConflict(error);
    }
}) as AppRouteHandler<typeof createLocationRoute>);

// ── Import a dataset chunk ──

const importEntrySchema = z.object({
    key: z.string().min(1).max(180),
    level: z.number().int().min(1).max(PLACE_MAX_LEVEL),
    parent: z.string().min(1).max(180).nullable(),
    name: z.string().min(1).max(200),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    active: z.boolean(),
    homeDelivery: z.boolean().optional(),
    pickup: z.boolean().optional(),
    legacyId: z.string().min(1).max(128).optional(),
});

const importRoute = createRoute({
    method: "post",
    path: "/import",
    operationId: "dashboard.delivery_locations.import",
    tags: ["Admin - Delivery Locations"],
    summary: "Import one chunk of a place dataset",
    description: "Idempotent: places match by key, then legacyId, then courier id, then name under the same parent. Send parents before children, at most 500 places per call; finish on the last call makes the dataset's own places it did not list inactive. Never deletes a place and never changes the status of a merchant's own place.",
    request: {
        body: { required: true, content: { "application/json": { schema: z.object({
            country: countryCodeSchema,
            source: z.string().min(1).max(64).openapi({ description: "The dataset id (bd): the source of the places this import creates" }),
            version: z.string().min(1).max(128).openapi({ description: "The dataset version (its manifest sha256)" }),
            places: z.array(importEntrySchema).max(PLACE_IMPORT_MAX_ENTRIES),
            finish: z.boolean().optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "What the chunk changed",
            content: { "application/json": { schema: successEnvelope(z.object({
                created: z.number().int(),
                updated: z.number().int(),
                unchanged: z.number().int(),
                skipped: z.number().int(),
                deactivated: z.number().int(),
                conflicts: z.array(z.object({
                    key: z.string(),
                    reason: z.enum(["parent_missing", "parent_mismatch", "level_changed", "name_taken"]),
                })).max(50),
                conflictCount: z.number().int(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(importRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await importPlaces(c.get("db"), {
        ...body,
        places: body.places.map((place) => ({
            ...place,
            externalIds: Object.fromEntries(Object.entries(place.externalIds).map(([courier, id]) => [courier, String(id)])),
        })),
    });
    return ok(c, result);
});

// ── Delete All Locations ──

const deleteAllRoute = createRoute({
    method: "delete",
    path: "/all",
    operationId: "dashboard.delivery_locations.delete_all",
    tags: ["Admin - Delivery Locations"],
    summary: "Delete all of a country's places permanently",
    request: {
        body: { required: true, content: { "application/json": { schema: z.object({
            confirmDeleteAll: z.literal(true),
            countryCode: countryCodeSchema,
        }) } } }
    },
    responses: {
        200: { description: "All locations deleted", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(deleteAllRoute, async (c) => {
    const { confirmDeleteAll, countryCode: rawCountry } = c.req.valid("json");
    if (!confirmDeleteAll) {
        throw new ValidationError("Must confirm deletion by setting confirmDeleteAll: true");
    }
    const countryCode = countryOf(rawCountry);
    const db = c.get("db");
    // Checkout reads Bangladesh's places only.
    if (countryCode === PLACE_ADDRESS_COUNTRY) await assertAllDeliveryLocationsCanBeRemovedFromCheckout(db);
    await db.delete(places).where(eq(places.countryCode, countryCode));

    return ok(c, { message: "All delivery locations have been permanently deleted." });
});

// ── Bulk Delete Locations ──

const bulkDeleteRoute = createRoute({
    method: "delete",
    path: "/",
    operationId: "dashboard.delivery_locations.bulk_delete",
    tags: ["Admin - Delivery Locations"],
    summary: "Bulk soft-delete places with everything under them",
    request: {
        body: { required: true, content: { "application/json": { schema: z.object({
            ids: z.array(z.string().trim().min(1).max(128)).min(1).max(90),
        }) } } }
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
        await assertDeliveryLocationsCanBeRemovedFromCheckout(db, ids);
        await deletePlaces(db, ids);

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
    operationId: "dashboard.delivery_locations.get",
    tags: ["Admin - Delivery Locations"],
    summary: "Get a place by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Location details", content: { "application/json": { schema: successEnvelope(deliveryLocationSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const location = await getPlaceById(db, id);
    if (!location) throw new NotFoundError("Location not found");
    return ok(c, formatPlace(location));
});

// ── Update Location ──

const updateLocationRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.delivery_locations.update",
    tags: ["Admin - Delivery Locations"],
    summary: "Update a place",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: updateLocationSchema } } }
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
                id: places.id,
                name: places.name,
                countryCode: places.countryCode,
                level: places.level,
                parentId: places.parentId,
                isActive: places.isActive,
            })
            .from(places)
            .where(and(eq(places.id, id), isNull(places.deletedAt)))
            .get();

        if (!currentLocation) throw new NotFoundError("Location not found");

        const nextParentId = parsedData.parentId !== undefined
            ? parsedData.parentId
            : currentLocation.parentId;
        const nextIsActive = parsedData.isActive ?? currentLocation.isActive;
        const nextName = parsedData.name ?? currentLocation.name;
        await assertValidLocationParent(db, currentLocation.countryCode, currentLocation.level, nextParentId, nextIsActive);
        await assertActiveLocationIdentityAvailable(
            db,
            currentLocation.countryCode,
            currentLocation.level,
            nextParentId,
            nextName,
            nextIsActive,
            id,
        );

        const removesCurrentLocationFromReadiness =
            currentLocation.isActive &&
            parsedData.isActive === false;
        if (removesCurrentLocationFromReadiness) {
            await assertDeliveryLocationsCanBeRemovedFromCheckout(db, [id]);
        }

        const updatedLocation = await updatePlace(db, id, parsedData);

        if (!updatedLocation) throw new NotFoundError("Location not found");

        return ok(c, formatPlace(updatedLocation));
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        rethrowDeliveryLocationIdentityConflict(error);
    }
});

// ── Reset Pathao Import ──

// Register this static DELETE route before /{id}; Hono resolves same-method
// routes in registration order, so the generic location route must not consume
// the reserved import-pathao segment.
const resetPathaoImportRoute = createRoute({
    method: "delete",
    path: "/import-pathao",
    operationId: "dashboard.delivery_locations.pathao_import_reset",
    tags: ["Admin - Delivery Locations"],
    summary: "Reset Pathao location import progress",
    responses: {
        200: {
            description: "Pathao import progress reset",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    },
});

app.openapi(resetPathaoImportRoute, async (c) => {
    const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
    if (!kv) throw new ValidationError("KV not available");

    await resetPathaoImportProgress(kv);
    return ok(c, { message: "Import progress reset. You can start a fresh import." });
});

// ── Delete Location ──

const deleteLocationRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.delivery_locations.trash",
    tags: ["Admin - Delivery Locations"],
    summary: "Soft-delete a place with everything under it",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Location deleted", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(deleteLocationRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const currentLocation = await db
        .select({
            id: places.id,
            countryCode: places.countryCode,
            level: places.level,
            isActive: places.isActive,
        })
        .from(places)
        .where(and(eq(places.id, id), isNull(places.deletedAt)))
        .get();

    if (!currentLocation) throw new NotFoundError("Location not found");
    // Checkout needs an active Bangladesh city with an active thana.
    if (currentLocation.isActive && currentLocation.countryCode === PLACE_ADDRESS_COUNTRY && currentLocation.level <= 2) {
        await assertDeliveryLocationsCanBeRemovedFromCheckout(db, [id]);
    }

    await deletePlaces(db, [id]);

    return ok(c, {});
});

// ── Pathao Location Import ──────────────────────────────────────────────────

const pathaoImportStatsSchema = z.object({
    citiesCreated: z.number().int().nonnegative(),
    citiesUpdated: z.number().int().nonnegative(),
    zonesCreated: z.number().int().nonnegative(),
    zonesUpdated: z.number().int().nonnegative(),
    areasCreated: z.number().int().nonnegative(),
    areasUpdated: z.number().int().nonnegative(),
});

const pathaoImportResultSchema = z.object({
    status: z.enum(["importing", "complete", "error"]),
    phase: z.enum(["cities", "zones", "areas", "done"]),
    progress: z.object({
        current: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        label: z.string(),
    }),
    stats: pathaoImportStatsSchema,
    error: z.string().optional(),
});

/**
 * POST /import-pathao — Process one chunk of Pathao location import.
 * Call repeatedly until status === "complete".
 * Admin UI drives the loop with a progress bar.
 */
const processPathaoImportRoute = createRoute({
    method: "post",
    path: "/import-pathao",
    operationId: "dashboard.delivery_locations.pathao_import_chunk",
    tags: ["Admin - Delivery Locations"],
    summary: "Process one bounded Pathao location import chunk",
    responses: {
        200: {
            description: "Current Pathao import progress",
            content: { "application/json": { schema: successEnvelope(pathaoImportResultSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(processPathaoImportRoute, async (c) => {
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
        const credentialRead = await readStoredCredentialStrict(
            provider.credentials,
            getCredentialEncryptionKey(c.env as Record<string, unknown>),
            "Delivery provider credentials",
        );
        if (credentialRead.error) {
            throw new Error(credentialRead.error);
        }
        const rawCreds = credentialRead.value;
        creds = JSON.parse(rawCreds);
    } catch {
        throw new ValidationError("Invalid Pathao credentials. Check your provider settings.");
    }

    if (!creds.baseUrl || !creds.clientId || !creds.clientSecret || !creds.username || !creds.password) {
        throw new ValidationError("Incomplete Pathao credentials. Ensure baseUrl, clientId, clientSecret, username, and password are configured.");
    }

    const result = await processPathaoImportChunk(db, kv, creds);

    return ok(c, result);
});

/**
 * GET /import-pathao/status — Check current import progress without processing.
 */
const getPathaoImportStatusRoute = createRoute({
    method: "get",
    path: "/import-pathao/status",
    operationId: "dashboard.delivery_locations.pathao_import_status",
    tags: ["Admin - Delivery Locations"],
    summary: "Get Pathao location import progress",
    responses: {
        200: {
            description: "Current Pathao import progress",
            content: { "application/json": { schema: successEnvelope(pathaoImportResultSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getPathaoImportStatusRoute, async (c) => {
    const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
    if (!kv) throw new ValidationError("KV not available");

    const status = await getPathaoImportStatus(kv);
    return ok(c, status);
});

export { app as adminLocationRoutes };
