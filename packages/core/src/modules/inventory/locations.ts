// Inventory locations (commerce hook H1): where physical stock is held.
//
// `inventory_levels` is trigger-maintained from ledger-v2 movements (and the
// stock a SKU is inserted with); nothing here writes it. This module owns the
// location records, the location every physical stock movement resolves to,
// and the read models (per-SKU breakdown, per-location on-hand).

import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database, D1_ID_CHUNK_SIZE } from "@scalius/database/client";
import {
    INVENTORY_LOCATION_KINDS,
    inventoryLevels,
    inventoryLocations,
    inventoryTransfers,
    orderFulfillments,
    orders,
    productVariants,
    purchaseOrders,
    type InventoryLocationKind,
} from "@scalius/database/schema";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { z } from "zod";
import { readIncomingStock, type IncomingStockRow } from "./inventory-insights";
import { readStoreCountry } from "../../utils/store-country";

/** RAISE message of the trigger that refuses a stock movement without an active location. */
export const INVENTORY_LOCATION_REQUIRED = "INVENTORY_LOCATION_REQUIRED";
/** CHECK on `inventory_levels.on_hand`: a location would go below zero. */
const LEVEL_NONNEGATIVE_CHECK = "inventory_levels_on_hand_nonnegative";
const CODE_UNIQUE_INDEX = /inventory_locations_code_unique/i;
/** Order statuses after which nothing more ships from the order's location. */
const CLOSED_ORDER_STATUSES = ["cancelled", "refunded", "returned", "delivered", "completed"] as const;

/** A location does not hold the units a stock movement takes from it. */
export class InventoryLocationShortfallError extends AppError {
    constructor(message: string, details?: unknown) {
        super(409, "INVENTORY_LOCATION_SHORTFALL", message, details);
        this.name = "InventoryLocationShortfallError";
    }
}

export interface InventoryLocationRef {
    id: string;
    name: string;
}

// ─────────────────────────────────────────
// Error recognition
// ─────────────────────────────────────────

function collectErrorText(error: unknown, depth = 0): string {
    if (depth > 5 || error === null || error === undefined) return "";
    if (typeof error !== "object") return String(error);
    const candidate = error as { message?: unknown; detail?: unknown; constraint?: unknown; cause?: unknown };
    return [candidate.message, candidate.detail, candidate.constraint, collectErrorText(candidate.cause, depth + 1)]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" ");
}

/** A batch aborted because a location level would have gone negative. */
export function isInventoryLevelShortfallError(error: unknown): boolean {
    return collectErrorText(error).includes(LEVEL_NONNEGATIVE_CHECK);
}

/** A batch aborted because a stock movement named no active location. */
export function isInventoryLocationRequiredError(error: unknown): boolean {
    return collectErrorText(error).includes(INVENTORY_LOCATION_REQUIRED);
}

/**
 * Turns a level/location trigger abort into the merchant-facing error; any
 * other error is returned unchanged for the caller to rethrow.
 */
export function inventoryLocationErrorFrom(error: unknown, locationName?: string): unknown {
    if (isInventoryLevelShortfallError(error)) {
        return new InventoryLocationShortfallError(locationName
            ? `${locationName} doesn't have enough units for this change. Move stock there or choose another location.`
            : "A location doesn't have enough units for this change. Adjust stock per location in Inventory.");
    }
    if (isInventoryLocationRequiredError(error)) {
        return new ConflictError("Choose an active location for this stock change.");
    }
    return error;
}

// ─────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────

/** The default location's id as a scalar subquery: physical stock moves there when no location is named. */
export function defaultInventoryLocationIdSql(): SQL<string | null> {
    return sql<string | null>`(SELECT ${inventoryLocations.id} FROM ${inventoryLocations} WHERE ${inventoryLocations.isDefault} = 1 AND ${inventoryLocations.status} = 'active')`;
}

export async function getDefaultInventoryLocation(db: Database): Promise<InventoryLocationRef> {
    const row = await db.select({ id: inventoryLocations.id, name: inventoryLocations.name })
        .from(inventoryLocations)
        .where(and(eq(inventoryLocations.isDefault, true), eq(inventoryLocations.status, "active")))
        .get();
    // Migration 0102 creates the default and nothing can remove it; fail closed.
    if (!row) throw new ConflictError("No default inventory location is set. Set one in Settings → Locations.");
    return row;
}

/** The named active location, or the default when none is named. */
export async function resolveActiveInventoryLocation(
    db: Database,
    locationId: string | null | undefined,
): Promise<InventoryLocationRef> {
    if (!locationId) return getDefaultInventoryLocation(db);
    const row = await db.select({
        id: inventoryLocations.id,
        name: inventoryLocations.name,
        status: inventoryLocations.status,
    }).from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).get();
    if (!row) throw new NotFoundError("Location not found");
    if (row.status !== "active") throw new ValidationError(`${row.name} is archived. Choose an active location.`);
    return { id: row.id, name: row.name };
}

/** Where an order's stock leaves from: its fulfilment location, or the default. */
export async function resolveOrderFulfillmentLocation(
    db: Database,
    fulfillmentLocationId: string | null | undefined,
): Promise<InventoryLocationRef> {
    if (!fulfillmentLocationId) return getDefaultInventoryLocation(db);
    const row = await db.select({
        id: inventoryLocations.id,
        name: inventoryLocations.name,
        status: inventoryLocations.status,
    }).from(inventoryLocations).where(eq(inventoryLocations.id, fulfillmentLocationId)).get();
    if (!row || row.status !== "active") {
        throw new ConflictError("This order's fulfilment location is archived. Choose another location for the order.");
    }
    return { id: row.id, name: row.name };
}

/** The ids among `locationIds` that are active locations. */
export async function selectActiveInventoryLocationIds(
    db: Database,
    locationIds: readonly string[],
): Promise<Set<string>> {
    const unique = [...new Set(locationIds)];
    const active = new Set<string>();
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({ id: inventoryLocations.id })
            .from(inventoryLocations)
            .where(and(
                inArray(inventoryLocations.id, unique.slice(index, index + D1_ID_CHUNK_SIZE)),
                eq(inventoryLocations.status, "active"),
            ))
            .all();
        for (const row of rows) active.add(row.id);
    }
    return active;
}

/** On-hand units of each SKU at one location (0 when the SKU has no level there). */
export async function readLocationOnHand(
    db: Database,
    locationId: string,
    variantIds: readonly string[],
): Promise<Map<string, number>> {
    const unique = [...new Set(variantIds)];
    const onHand = new Map<string, number>(unique.map((id) => [id, 0]));
    for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({ variantId: inventoryLevels.variantId, onHand: inventoryLevels.onHand })
            .from(inventoryLevels)
            .where(and(
                eq(inventoryLevels.locationId, locationId),
                inArray(inventoryLevels.variantId, unique.slice(index, index + D1_ID_CHUNK_SIZE)),
            ))
            .all();
        for (const row of rows) onHand.set(row.variantId, row.onHand);
    }
    return onHand;
}

/**
 * Refuses a physical stock removal the location cannot cover, before any
 * write, naming the location and the SKUs. The level CHECK still aborts the
 * batch if stock moved in between.
 */
export async function assertInventoryLocationCovers(
    db: Database,
    location: InventoryLocationRef,
    removals: ReadonlyArray<{ variantId: string; quantity: number }>,
): Promise<void> {
    const needed = new Map<string, number>();
    for (const removal of removals) {
        if (removal.quantity <= 0) continue;
        needed.set(removal.variantId, (needed.get(removal.variantId) ?? 0) + removal.quantity);
    }
    if (needed.size === 0) return;
    const onHand = await readLocationOnHand(db, location.id, [...needed.keys()]);
    const short = [...needed].flatMap(([variantId, quantity]) => {
        const available = onHand.get(variantId) ?? 0;
        return available < quantity ? [{ variantId, needed: quantity, onHand: available }] : [];
    });
    if (short.length === 0) return;
    const skus = await db.select({ id: productVariants.id, sku: productVariants.sku })
        .from(productVariants)
        .where(inArray(productVariants.id, short.slice(0, D1_ID_CHUNK_SIZE).map((row) => row.variantId)))
        .all();
    const skuById = new Map(skus.map((row) => [row.id, row.sku]));
    const first = short[0]!;
    const label = skuById.get(first.variantId) ?? "A SKU";
    throw new InventoryLocationShortfallError(
        `${location.name} has ${first.onHand} of ${label}, ${first.needed} needed.`
            + (short.length > 1 ? ` ${short.length - 1} more SKU${short.length > 2 ? "s are" : " is"} short there too.` : "")
            + " Move stock there or choose another location.",
        {
            locationId: location.id,
            shortfalls: short.map((row) => ({ ...row, sku: skuById.get(row.variantId) ?? null })),
        },
    );
}

// ─────────────────────────────────────────
// Location records
// ─────────────────────────────────────────

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const inventoryLocationInputSchema = z.object({
    name: z.string().trim().min(1, "Enter a name.").max(80),
    code: z.string().trim().min(1, "Enter a code.").max(24)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use letters, numbers, hyphens or underscores."),
    kind: z.enum(INVENTORY_LOCATION_KINDS).optional(),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(80),
    postalCode: optionalText(20),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.").optional(),
    phone: optionalText(32),
});
export type InventoryLocationInput = z.input<typeof inventoryLocationInputSchema>;

export const updateInventoryLocationSchema = inventoryLocationInputSchema.extend({
    expectedVersion: z.number().int().min(1),
});
export type UpdateInventoryLocationInput = z.input<typeof updateInventoryLocationSchema>;

/** The stored shape of a location form: blank optional text is null. */
function locationValues(input: z.output<typeof inventoryLocationInputSchema>) {
    const blankToNull = (value: string | null | undefined) => (value ? value : null);
    return {
        name: input.name,
        code: input.code,
        kind: input.kind ?? "warehouse",
        addressLine1: blankToNull(input.addressLine1),
        addressLine2: blankToNull(input.addressLine2),
        city: blankToNull(input.city),
        postalCode: blankToNull(input.postalCode),
        // Omitted: a new location takes the store's country, an edit keeps its own.
        countryCode: input.countryCode?.toUpperCase(),
        phone: blankToNull(input.phone),
    };
}

function parseLocationInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid location", {
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
    }
    return parsed.data;
}

export interface InventoryLocationRecord {
    id: string;
    name: string;
    code: string;
    kind: InventoryLocationKind;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    countryCode: string;
    phone: string | null;
    isDefault: boolean;
    status: "active" | "archived";
    position: number;
    version: number;
    /** Units on hand there, across every SKU. */
    onHand: number;
    /** SKUs with units on hand there. */
    stockedSkus: number;
    createdAt: Date;
    updatedAt: Date;
}

const locationFields = {
    id: inventoryLocations.id,
    name: inventoryLocations.name,
    code: inventoryLocations.code,
    kind: inventoryLocations.kind,
    addressLine1: inventoryLocations.addressLine1,
    addressLine2: inventoryLocations.addressLine2,
    city: inventoryLocations.city,
    postalCode: inventoryLocations.postalCode,
    countryCode: inventoryLocations.countryCode,
    phone: inventoryLocations.phone,
    isDefault: inventoryLocations.isDefault,
    status: inventoryLocations.status,
    position: inventoryLocations.position,
    version: inventoryLocations.version,
    createdAt: inventoryLocations.createdAt,
    updatedAt: inventoryLocations.updatedAt,
};

/** Active locations first (default, then position), archived ones last when asked for. */
export async function listInventoryLocations(
    db: Database,
    options: { includeArchived?: boolean } = {},
): Promise<InventoryLocationRecord[]> {
    const stock = db.select({
        locationId: inventoryLevels.locationId,
        onHand: sql<number>`COALESCE(SUM(${inventoryLevels.onHand}), 0)`.as("on_hand_total"),
        stockedSkus: sql<number>`COUNT(CASE WHEN ${inventoryLevels.onHand} > 0 THEN 1 END)`.as("stocked_skus"),
    }).from(inventoryLevels).groupBy(inventoryLevels.locationId).as("location_stock");
    const rows = await db.select({
        ...locationFields,
        onHand: sql<number>`COALESCE(${stock.onHand}, 0)`,
        stockedSkus: sql<number>`COALESCE(${stock.stockedSkus}, 0)`,
    })
        .from(inventoryLocations)
        .leftJoin(stock, eq(stock.locationId, inventoryLocations.id))
        .where(options.includeArchived ? undefined : eq(inventoryLocations.status, "active"))
        .orderBy(
            asc(inventoryLocations.status),
            desc(inventoryLocations.isDefault),
            asc(inventoryLocations.position),
            asc(inventoryLocations.name),
        )
        .all();
    return rows.map((row) => ({
        ...row,
        onHand: Number(row.onHand),
        stockedSkus: Number(row.stockedSkus),
    }));
}

async function getInventoryLocationRecord(db: Database, id: string): Promise<InventoryLocationRecord> {
    const rows = await listInventoryLocations(db, { includeArchived: true });
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new NotFoundError("Location not found");
    return row;
}

async function assertCodeAvailable(db: Database, code: string, exceptId?: string): Promise<void> {
    const taken = await db.select({ id: inventoryLocations.id })
        .from(inventoryLocations)
        .where(and(
            sql`lower(trim(${inventoryLocations.code})) = ${code.trim().toLowerCase()}`,
            exceptId ? ne(inventoryLocations.id, exceptId) : undefined,
        ))
        .get();
    if (taken) throw new ConflictError("Another location already uses this code.");
}

function rethrowCodeConflict(error: unknown): never {
    const text = collectErrorText(error);
    if (/unique|duplicate key/i.test(text) && CODE_UNIQUE_INDEX.test(text)) {
        throw new ConflictError("Another location already uses this code.");
    }
    throw error;
}

export async function createInventoryLocation(
    db: Database,
    input: InventoryLocationInput,
): Promise<InventoryLocationRecord> {
    const data = locationValues(parseLocationInput(inventoryLocationInputSchema, input));
    await assertCodeAvailable(db, data.code);
    // A location without a country is in the store's (the backup market's).
    const countryCode = data.countryCode ?? await readStoreCountry(db);
    if (!countryCode) throw new ValidationError("Choose the location's country.", { field: "countryCode" });
    const id = `loc_${nanoid(16)}`;
    try {
        await db.insert(inventoryLocations).values({
            id,
            ...data,
            countryCode,
            isDefault: false,
            status: "active",
            position: sql`(SELECT COALESCE(MAX(${inventoryLocations.position}), 0) + 1 FROM ${inventoryLocations})`,
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
    } catch (error) {
        rethrowCodeConflict(error);
    }
    return getInventoryLocationRecord(db, id);
}

export async function updateInventoryLocation(
    db: Database,
    id: string,
    input: UpdateInventoryLocationInput,
): Promise<InventoryLocationRecord> {
    const { expectedVersion, ...fields } = parseLocationInput(updateInventoryLocationSchema, input);
    const data = locationValues(fields);
    await assertCodeAvailable(db, data.code, id);
    let updated: Array<{ id: string }>;
    try {
        updated = await db.update(inventoryLocations).set({
            ...data,
            version: sql`${inventoryLocations.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(inventoryLocations.id, id),
            eq(inventoryLocations.version, expectedVersion),
        )).returning({ id: inventoryLocations.id });
    } catch (error) {
        rethrowCodeConflict(error);
    }
    if (updated.length === 0) {
        await getInventoryLocationRecord(db, id);
        throw new ConflictError("This location changed. Reload to see the latest.");
    }
    return getInventoryLocationRecord(db, id);
}

/** Orders that still ship from a location: not deducted yet and not closed. */
function openOrdersAtLocation(locationId: string | SQL): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.fulfillmentLocationId} = ${locationId}
          AND ${orders.deletedAt} IS NULL
          AND ${orders.inventoryAction} IN ('none', 'reserved')
          AND ${orders.status} NOT IN (${sql.join(CLOSED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)})
    )`;
}

/**
 * Archives a location that holds nothing: not the default, no units on hand,
 * and no open order set to ship from it. One guarded statement, so stock or
 * an order arriving concurrently cannot slip past the guard.
 */
export async function archiveInventoryLocation(db: Database, id: string): Promise<InventoryLocationRecord> {
    const archived = await db.update(inventoryLocations).set({
        status: "archived",
        version: sql`${inventoryLocations.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(inventoryLocations.id, id),
        eq(inventoryLocations.status, "active"),
        eq(inventoryLocations.isDefault, false),
        sql`NOT EXISTS (
            SELECT 1 FROM ${inventoryLevels}
            WHERE ${inventoryLevels.locationId} = ${id} AND ${inventoryLevels.onHand} > 0
        )`,
        sql`NOT ${openOrdersAtLocation(id)}`,
        sql`NOT ${openStockDocumentsAtLocation(id)}`,
    )).returning({ id: inventoryLocations.id });
    if (archived.length > 0) return getInventoryLocationRecord(db, id);

    const location = await getInventoryLocationRecord(db, id);
    if (location.status === "archived") return location;
    if (location.isDefault) {
        throw new ConflictError("The default location can't be archived. Make another location the default first.");
    }
    if (location.onHand > 0) {
        throw new ConflictError(`${location.name} still holds ${location.onHand} units. Move or adjust that stock to zero first.`);
    }
    const documents = await db.select({ open: sql<number>`CASE WHEN ${openStockDocumentsAtLocation(id)} THEN 1 ELSE 0 END` })
        .from(inventoryLocations).where(eq(inventoryLocations.id, id)).get();
    if (documents?.open) {
        throw new ConflictError(`Purchase orders or transfers still arrive at or leave from ${location.name}. Receive or cancel them first.`);
    }
    throw new ConflictError(`Open orders are set to ship from ${location.name}. Change their location first.`);
}

/**
 * Purchase orders still expected at a location, and transfers on their way
 * to or from it (in transit units return to the origin on cancel, so it
 * must stay active).
 */
function openStockDocumentsAtLocation(locationId: string): SQL {
    return sql`(EXISTS (
        SELECT 1 FROM ${purchaseOrders}
        WHERE ${purchaseOrders.destinationLocationId} = ${locationId}
          AND ${purchaseOrders.status} IN ('ordered', 'partially_received')
    ) OR EXISTS (
        SELECT 1 FROM ${inventoryTransfers}
        WHERE (${inventoryTransfers.originLocationId} = ${locationId} OR ${inventoryTransfers.destinationLocationId} = ${locationId})
          AND ${inventoryTransfers.status} IN ('in_transit', 'partially_received')
    ))`;
}

export async function unarchiveInventoryLocation(db: Database, id: string): Promise<InventoryLocationRecord> {
    await db.update(inventoryLocations).set({
        status: "active",
        version: sql`${inventoryLocations.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(inventoryLocations.id, id), eq(inventoryLocations.status, "archived")));
    return getInventoryLocationRecord(db, id);
}

/**
 * Makes an active location the default in one batch: the old default is
 * cleared only when the new one is active, so there is always exactly one.
 */
export async function setDefaultInventoryLocation(db: Database, id: string): Promise<InventoryLocationRecord> {
    const targetActive = sql`EXISTS (
        SELECT 1 FROM ${inventoryLocations} AS target
        WHERE target.id = ${id} AND target.status = 'active'
    )`;
    await safeBatch(db, [
        db.update(inventoryLocations).set({
            isDefault: false,
            version: sql`${inventoryLocations.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(inventoryLocations.isDefault, true),
            ne(inventoryLocations.id, id),
            targetActive,
        )),
        db.update(inventoryLocations).set({
            isDefault: true,
            version: sql`${inventoryLocations.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(inventoryLocations.id, id),
            eq(inventoryLocations.status, "active"),
            eq(inventoryLocations.isDefault, false),
        )),
    ] as never);
    const location = await getInventoryLocationRecord(db, id);
    if (location.status !== "active") {
        throw new ValidationError(`${location.name} is archived. Unarchive it before making it the default.`);
    }
    return location;
}

// ─────────────────────────────────────────
// Levels
// ─────────────────────────────────────────

export interface VariantInventoryLevels {
    variantId: string;
    stock: number;
    reservedStock: number;
    levels: Array<{
        locationId: string;
        name: string;
        code: string;
        isDefault: boolean;
        status: "active" | "archived";
        onHand: number;
    }>;
}

/** One SKU's on-hand at every active location (0 where it has none), plus any archived location still holding it. */
export async function getVariantInventoryLevels(db: Database, variantId: string): Promise<VariantInventoryLevels> {
    const variant = await db.select({
        id: productVariants.id,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
    }).from(productVariants).where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt))).get();
    if (!variant) throw new NotFoundError("Variant not found");
    const rows = await db.select({
        locationId: inventoryLocations.id,
        name: inventoryLocations.name,
        code: inventoryLocations.code,
        isDefault: inventoryLocations.isDefault,
        status: inventoryLocations.status,
        onHand: sql<number>`COALESCE(${inventoryLevels.onHand}, 0)`,
    })
        .from(inventoryLocations)
        .leftJoin(inventoryLevels, and(
            eq(inventoryLevels.locationId, inventoryLocations.id),
            eq(inventoryLevels.variantId, variantId),
        ))
        .where(sql`(${inventoryLocations.status} = 'active' OR COALESCE(${inventoryLevels.onHand}, 0) > 0)`)
        .orderBy(desc(inventoryLocations.isDefault), asc(inventoryLocations.position), asc(inventoryLocations.name))
        .all();
    return {
        variantId: variant.id,
        stock: variant.stock,
        reservedStock: variant.reservedStock,
        levels: rows.map((row) => ({ ...row, onHand: Number(row.onHand) })),
    };
}

export interface ProductInventoryLevels {
    productId: string;
    /** Every live SKU's units at each location holding some (zero levels are omitted). */
    levels: Array<{ variantId: string; locationId: string; onHand: number }>;
    /**
     * Units coming to each location: open purchase order quantities and
     * transfers in transit (rows with nothing incoming are omitted). Not on
     * hand, and not in the SKU's stock.
     */
    incoming: IncomingStockRow[];
}

/**
 * The per-location on-hand of a product's live SKUs in one bounded read (a
 * product has at most MAX_PRODUCT_OPTION_COMBINATIONS SKUs, one bound
 * parameter), for the product editor's per-location breakdown.
 */
export async function getProductInventoryLevels(db: Database, productId: string): Promise<ProductInventoryLevels> {
    const rows = await db.select({
        variantId: inventoryLevels.variantId,
        locationId: inventoryLevels.locationId,
        onHand: inventoryLevels.onHand,
    })
        .from(inventoryLevels)
        .innerJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
        .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryLevels.locationId))
        .where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
            sql`${inventoryLevels.onHand} > 0`,
        ))
        // Each SKU's locations in the order the Locations list shows them.
        .orderBy(
            asc(inventoryLevels.variantId),
            desc(inventoryLocations.isDefault),
            asc(inventoryLocations.position),
            asc(inventoryLocations.name),
            asc(inventoryLevels.locationId),
        )
        .all();
    const variantIds = await db.select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
        .all();
    const incoming = await readIncomingStock(db, variantIds.map((row) => row.id));
    return { productId, levels: rows.map((row) => ({ ...row, onHand: Number(row.onHand) })), incoming };
}

/** A SKU's units held anywhere but the default location, largest first. */
export async function readVariantStockAwayFromDefault(
    db: Database,
    variantId: string,
): Promise<Array<{ locationId: string; name: string; onHand: number }>> {
    const rows = await db.select({
        locationId: inventoryLocations.id,
        name: inventoryLocations.name,
        onHand: inventoryLevels.onHand,
    })
        .from(inventoryLevels)
        .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryLevels.locationId))
        .where(and(
            eq(inventoryLevels.variantId, variantId),
            eq(inventoryLocations.isDefault, false),
            sql`${inventoryLevels.onHand} > 0`,
        ))
        .orderBy(desc(inventoryLevels.onHand), asc(inventoryLocations.name))
        .all();
    return rows.map((row) => ({ ...row, onHand: Number(row.onHand) }));
}

/** On-hand at one location as a scalar subquery for a SKU listing. */
export function locationOnHandSql(locationId: string): SQL<number> {
    return sql<number>`COALESCE((
        SELECT ${inventoryLevels.onHand} FROM ${inventoryLevels}
        WHERE ${inventoryLevels.variantId} = ${productVariants.id}
          AND ${inventoryLevels.locationId} = ${locationId}
    ), 0)`;
}

// ─────────────────────────────────────────
// Order fulfilment location
// ─────────────────────────────────────────

/**
 * Whether an order's fulfilment location can still change: nothing has been
 * deducted for it and no ship/pickup fulfilment has left.
 */
export function orderFulfillmentLocationChangeBlockedSql(orderId: string): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${orderFulfillments}
        WHERE ${orderFulfillments.orderId} = ${orderId}
          AND ${orderFulfillments.status} = 'active'
          AND ${orderFulfillments.kind} IN ('ship', 'pickup')
    )`;
}
