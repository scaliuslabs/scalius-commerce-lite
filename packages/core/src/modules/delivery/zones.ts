/**
 * Delivery zones and their rates (Shopify shipping zones on the Pathao
 * city → zone → area tree).
 *
 * A zone is a name plus a set of locations; a location belongs to at most one
 * zone. A buyer address resolves to the zone of its most specific assigned
 * location (area, then zone, then city); an address in no zone gets the rates
 * without a zone ("Everywhere else"). A rate (a `shipping_methods` row) can be
 * free once the items subtotal, before discounts, reaches a threshold.
 * Checkout never trusts a client fee: `resolveDeliveryRate` is the one place
 * that decides whether a rate applies and what it costs.
 */
import { z } from "zod";
import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    deliveryLocations,
    deliveryZoneLocations,
    deliveryZones,
    shippingMethods,
} from "@scalius/database/schema";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { defineSettingsDocument, SettingsRevisionConflictError } from "../settings/settings-store";

type Statement = BatchItem<"sqlite">;

/** Largest charge or free-over threshold, in major units (৳1,00,000). */
export const MAX_DELIVERY_AMOUNT = 100_000;
export const MAX_ZONE_RATES = 20;
export const MAX_ZONE_LOCATIONS = 2_000;

export type DeliveryRateKind = "delivery" | "pickup";

// D1 binds at most 100 parameters per statement.
const LOCATION_CHUNK = 45;
const now = sql`(cast(strftime('%s','now') as int))`;

// ── Checkout: the one rate resolution ──────────────────────────────────

export interface DeliveryRateRow {
    id: string;
    /** Null for an "Everywhere else" rate. */
    zoneId: string | null;
    name: string;
    description: string | null;
    feeMinor: number;
    freeOverMinor: number | null;
    isActive: boolean;
    deletedAt?: Date | number | null;
    kind?: DeliveryRateKind;
}

/** Live, active rates by id. */
export function selectDeliveryRateRowsByIds(db: Database, rawIds: readonly string[]) {
    const ids = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))];
    const query = db
        .select({
            id: shippingMethods.id,
            zoneId: shippingMethods.zoneId,
            name: shippingMethods.name,
            description: shippingMethods.description,
            feeMinor: shippingMethods.feeMinor,
            freeOverMinor: shippingMethods.freeOverMinor,
            isActive: shippingMethods.isActive,
            deletedAt: shippingMethods.deletedAt,
            kind: shippingMethods.kind,
        })
        .from(shippingMethods);
    if (ids.length === 0) return query.limit(0);
    return query.where(and(
        inArray(shippingMethods.id, ids),
        eq(shippingMethods.isActive, true),
        isNull(shippingMethods.deletedAt),
    ));
}

export interface DeliveryAddress {
    city: string;
    zone?: string | null;
    area?: string | null;
}

/**
 * The zone an address resolves to, from its location rows (each carrying its
 * zone membership); null means the "Everywhere else" rates apply.
 */
export function resolveAddressZoneId(
    address: DeliveryAddress,
    locationRows: readonly { id: string; deliveryZoneId?: string | null }[],
): string | null {
    const zoneOf = new Map(locationRows.map((row) => [row.id, row.deliveryZoneId ?? null]));
    for (const id of [address.area, address.zone, address.city]) {
        const zoneId = id ? zoneOf.get(id) : null;
        if (zoneId) return zoneId;
    }
    return null;
}

export interface ResolvedDeliveryRate {
    id: string;
    /** "pickup" needs no delivery address; the buyer collects the order. */
    kind: DeliveryRateKind;
    name: string;
    description: string | null;
    /** The rate's own charge. */
    baseFeeMinor: number;
    /** What the buyer pays for delivery (0 once the free-over threshold is met). */
    feeMinor: number;
    freeOverApplied: boolean;
}

/**
 * `details.reason` of the refusal when the chosen rate is gone or doesn't
 * serve the address: checkout re-reads the address's rates instead of
 * reporting a failure.
 */
export const DELIVERY_RATE_UNAVAILABLE_REASON = "delivery_rate_unavailable";

/**
 * Verifies the chosen rate is live, active, well formed and offered for the
 * address's zone (local pickup is offered everywhere), then applies its
 * free-over threshold to the items subtotal.
 */
export function resolveDeliveryRate(input: {
    rate: DeliveryRateRow | undefined;
    addressZoneId: string | null;
    subtotalMinor: number;
}): ResolvedDeliveryRate {
    const { rate, addressZoneId, subtotalMinor } = input;
    if (!rate || !rate.isActive || rate.deletedAt != null) {
        throw new ValidationError(
            "A valid active shipping method is required for this order.",
            { reason: DELIVERY_RATE_UNAVAILABLE_REASON },
        );
    }
    const kind = rate.kind ?? "delivery";
    if (kind === "delivery" && (rate.zoneId ?? null) !== addressZoneId) {
        throw new ValidationError(
            "This delivery option isn't available for the selected address. Choose another delivery option.",
            { reason: DELIVERY_RATE_UNAVAILABLE_REASON },
        );
    }
    const name = typeof rate.name === "string" ? rate.name.trim() : "";
    const description = typeof rate.description === "string" ? rate.description.trim() || null : null;
    const freeOver = rate.freeOverMinor ?? null;
    if (
        !Number.isSafeInteger(rate.feeMinor)
        || rate.feeMinor < 0
        || (freeOver !== null && (!Number.isSafeInteger(freeOver) || freeOver < 0))
        || !name
        || name.length > 100
        || (description?.length ?? 0) > 255
    ) {
        throw new ValidationError("Selected shipping method is misconfigured.");
    }
    const freeOverApplied = freeOver !== null && subtotalMinor >= freeOver;
    return {
        id: rate.id,
        kind,
        name,
        description,
        baseFeeMinor: rate.feeMinor,
        feeMinor: freeOverApplied ? 0 : rate.feeMinor,
        freeOverApplied,
    };
}

// ── Storefront: rates for an address ───────────────────────────────────

/**
 * Live, active rates offered at checkout. With an address, only the rates of
 * the zone it resolves to plus local pickup (an empty list means the store
 * doesn't deliver there); without one, every active rate.
 */
export async function listDeliveryRatesForAddress(db: Database, address: DeliveryAddress | null) {
    const conditions: SQL[] = [eq(shippingMethods.isActive, true), isNull(shippingMethods.deletedAt)];
    if (address) {
        const ids = [address.city, address.zone, address.area].filter((id): id is string => Boolean(id));
        const memberships = await db
            .select({ id: deliveryZoneLocations.locationId, deliveryZoneId: deliveryZoneLocations.zoneId })
            .from(deliveryZoneLocations)
            .where(inArray(deliveryZoneLocations.locationId, ids));
        conditions.push(or(zoneScope(resolveAddressZoneId(address, memberships)), eq(shippingMethods.kind, "pickup"))!);
    }
    return db
        .select({
            id: shippingMethods.id,
            name: shippingMethods.name,
            description: shippingMethods.description,
            feeMinor: shippingMethods.feeMinor,
            freeOverMinor: shippingMethods.freeOverMinor,
            kind: shippingMethods.kind,
            pickupAddress: shippingMethods.pickupAddress,
            pickupHours: shippingMethods.pickupHours,
            isActive: shippingMethods.isActive,
            sortOrder: shippingMethods.sortOrder,
            createdAt: shippingMethods.createdAt,
            updatedAt: shippingMethods.updatedAt,
        })
        .from(shippingMethods)
        .where(and(...conditions))
        .orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.name));
}

// ── Dashboard: zones and "Everywhere else" ─────────────────────────────

/**
 * "Everywhere else" has no zone row; this empty settings document carries its
 * revision so two staff editing it can't overwrite each other.
 */
const everywhereElseDocument = defineSettingsDocument<Record<string, never>>({
    key: "delivery_everywhere_else",
    schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    defaults: {},
});

export interface DeliveryZoneLocationView {
    id: string;
    name: string;
    type: "city" | "zone" | "area";
    /** "Dhaka" for a zone, "Mirpur, Dhaka" for an area; null for a city. */
    parentName: string | null;
}

export interface DeliveryRateView {
    id: string;
    kind: DeliveryRateKind;
    name: string;
    fee: number;
    freeOver: number | null;
    description: string | null;
    pickupAddress: string | null;
    pickupHours: string | null;
    isActive: boolean;
}

export interface DeliveryZoneView {
    id: string;
    name: string;
    revision: number;
    locations: DeliveryZoneLocationView[];
    rates: DeliveryRateView[];
}

export interface DeliveryZonesView {
    zones: DeliveryZoneView[];
    everywhereElse: { revision: number; rates: DeliveryRateView[] };
}

export async function listDeliveryZones(db: Database, decimalPlaces: number): Promise<DeliveryZonesView> {
    const parent = alias(deliveryLocations, "parent_location");
    const grandparent = alias(deliveryLocations, "grandparent_location");
    const [zones, locations, rates, everywhereElse] = await Promise.all([
        db.select().from(deliveryZones).orderBy(asc(deliveryZones.sortOrder), asc(deliveryZones.createdAt)),
        db
            .select({
                zoneId: deliveryZoneLocations.zoneId,
                id: deliveryLocations.id,
                name: deliveryLocations.name,
                type: deliveryLocations.type,
                parentName: parent.name,
                grandparentName: grandparent.name,
            })
            .from(deliveryZoneLocations)
            .innerJoin(deliveryLocations, eq(deliveryLocations.id, deliveryZoneLocations.locationId))
            .leftJoin(parent, eq(parent.id, deliveryLocations.parentId))
            .leftJoin(grandparent, eq(grandparent.id, parent.parentId))
            .where(isNull(deliveryLocations.deletedAt))
            .orderBy(asc(deliveryLocations.name)),
        db.select().from(shippingMethods).where(isNull(shippingMethods.deletedAt))
            .orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.name)),
        everywhereElseDocument.readDetailed(db, {}, { skipCache: true }),
    ]);
    const ratesOf = (zoneId: string | null): DeliveryRateView[] => rates
        .filter((rate) => (rate.zoneId ?? null) === zoneId)
        .map((rate) => ({
            id: rate.id,
            kind: rate.kind,
            name: rate.name,
            fee: fromMinor(rate.feeMinor, decimalPlaces),
            freeOver: rate.freeOverMinor === null ? null : fromMinor(rate.freeOverMinor, decimalPlaces),
            description: rate.description,
            pickupAddress: rate.pickupAddress,
            pickupHours: rate.pickupHours,
            isActive: rate.isActive,
        }));
    return {
        zones: zones.map((zone) => ({
            id: zone.id,
            name: zone.name,
            revision: zone.revision,
            locations: locations
                .filter((location) => location.zoneId === zone.id)
                .map((location) => ({
                    id: location.id,
                    name: location.name,
                    type: location.type,
                    parentName: [location.parentName, location.grandparentName].filter(Boolean).join(", ") || null,
                })),
            rates: ratesOf(zone.id),
        })),
        everywhereElse: { revision: everywhereElse.revision, rates: ratesOf(null) },
    };
}

/** Rates as the dashboard sends them; amounts are decimal major units. */
export interface DeliveryRateInput {
    id?: string | null;
    kind?: DeliveryRateKind;
    pickupAddress?: string | null;
    pickupHours?: string | null;
    name: string;
    fee: number;
    freeOver?: number | null;
    description?: string | null;
    isActive: boolean;
}

export interface DeliveryZoneInput {
    name: string;
    locationIds: string[];
    rates: DeliveryRateInput[];
}

interface Issue {
    path: Array<string | number>;
    message: string;
}

interface ParsedRate {
    id: string | null;
    kind: DeliveryRateKind;
    pickupAddress: string | null;
    pickupHours: string | null;
    name: string;
    feeMinor: number;
    freeOverMinor: number | null;
    description: string | null;
    isActive: boolean;
}

function amountToMinor(value: number, decimalPlaces: number, path: Issue["path"], issues: Issue[]): number {
    if (!Number.isFinite(value) || value < 0 || value > MAX_DELIVERY_AMOUNT) {
        issues.push({ path, message: "Enter an amount from 0 to 1,00,000." });
        return 0;
    }
    const minor = toMinor(value, decimalPlaces);
    if (fromMinor(minor, decimalPlaces) !== value) {
        issues.push({ path, message: `Use up to ${decimalPlaces} decimal places.` });
    }
    return minor;
}

function parseRates(
    rates: readonly DeliveryRateInput[],
    decimalPlaces: number,
    issues: Issue[],
    inZone: boolean,
): ParsedRate[] {
    const seen = new Set<string>();
    return rates.map((rate, index) => {
        const kind = rate.kind ?? "delivery";
        const pickupAddress = kind === "pickup" ? rate.pickupAddress?.trim() || null : null;
        const pickupHours = kind === "pickup" ? rate.pickupHours?.trim() || null : null;
        if (kind === "pickup" && inZone) {
            issues.push({ path: ["rates", index, "kind"], message: "Add pickup under Everywhere else: it's offered to every buyer." });
        }
        if (kind === "pickup" && !pickupAddress) {
            issues.push({ path: ["rates", index, "pickupAddress"], message: "Enter the address where buyers pick up." });
        } else if ((pickupAddress?.length ?? 0) > 500) {
            issues.push({ path: ["rates", index, "pickupAddress"], message: "Use 500 characters or fewer." });
        }
        if ((pickupHours?.length ?? 0) > 120) {
            issues.push({ path: ["rates", index, "pickupHours"], message: "Use 120 characters or fewer." });
        }
        const name = rate.name.trim();
        if (!name) issues.push({ path: ["rates", index, "name"], message: "Enter a name buyers will see." });
        else if (seen.has(name.toLowerCase())) {
            issues.push({ path: ["rates", index, "name"], message: "Use a different name for each rate." });
        }
        seen.add(name.toLowerCase());
        const freeOver = rate.freeOver ?? null;
        return {
            id: rate.id?.trim() || null,
            kind,
            pickupAddress,
            pickupHours,
            name,
            feeMinor: amountToMinor(rate.fee, decimalPlaces, ["rates", index, "fee"], issues),
            freeOverMinor: freeOver === null
                ? null
                : amountToMinor(freeOver, decimalPlaces, ["rates", index, "freeOver"], issues),
            description: rate.description?.trim() || null,
            isActive: rate.isActive,
        };
    });
}

function throwIssues(issues: readonly Issue[]): void {
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });
}

function zoneScope(zoneId: string | null): SQL {
    return zoneId ? eq(shippingMethods.zoneId, zoneId) : isNull(shippingMethods.zoneId);
}

async function liveRateIds(db: Database, zoneId: string | null): Promise<string[]> {
    const rows = await db.select({ id: shippingMethods.id }).from(shippingMethods)
        .where(and(zoneScope(zoneId), isNull(shippingMethods.deletedAt)));
    return rows.map((row) => row.id);
}

/**
 * Checkout needs at least one active rate: a write may not remove the last
 * one (unless the store never had one).
 */
async function assertCheckoutKeepsARate(db: Database, zoneId: string | null, nextActive: number) {
    if (nextActive > 0) return;
    const rows = await db.select({ zoneId: shippingMethods.zoneId }).from(shippingMethods)
        .where(and(eq(shippingMethods.isActive, true), isNull(shippingMethods.deletedAt)));
    if (rows.length > 0 && rows.every((row) => (row.zoneId ?? null) === zoneId)) {
        throw new ValidationError("Keep at least one active delivery rate so buyers can check out.");
    }
}

/**
 * Soft-deletes rates the merchant removed, updates kept ones in place (ids
 * stay stable for orders that reference them) and inserts new ones.
 */
function rateWriteStatements(
    db: Database,
    zoneId: string | null,
    rates: readonly ParsedRate[],
    currentIds: readonly string[],
): Statement[] {
    const current = new Set(currentIds);
    const kept = rates.filter((rate) => rate.id && current.has(rate.id));
    const keptIds = kept.map((rate) => rate.id!);
    const statements: Statement[] = [
        db.update(shippingMethods)
            .set({ deletedAt: now, updatedAt: now })
            .where(and(
                zoneScope(zoneId),
                isNull(shippingMethods.deletedAt),
                ...(keptIds.length ? [notInArray(shippingMethods.id, keptIds)] : []),
            )),
    ];
    // Unique placeholder names first, so swapping two names can't collide.
    if (kept.length > 1) {
        statements.push(db.update(shippingMethods).set({ name: sql`${shippingMethods.id}` }).where(inArray(shippingMethods.id, keptIds)));
    }
    rates.forEach((rate, sortOrder) => {
        const values = {
            kind: rate.kind,
            pickupAddress: rate.pickupAddress,
            pickupHours: rate.pickupHours,
            name: rate.name,
            feeMinor: rate.feeMinor,
            freeOverMinor: rate.freeOverMinor,
            description: rate.description,
            isActive: rate.isActive,
            sortOrder,
        };
        statements.push(rate.id && current.has(rate.id)
            ? db.update(shippingMethods).set({ ...values, updatedAt: now }).where(eq(shippingMethods.id, rate.id))
            : db.insert(shippingMethods).values({ ...values, id: `sm_${nanoid()}`, zoneId }));
    });
    return statements;
}

function locationStatements(db: Database, zoneId: string, locationIds: readonly string[]): Statement[] {
    const statements: Statement[] = [db.delete(deliveryZoneLocations).where(eq(deliveryZoneLocations.zoneId, zoneId))];
    for (let start = 0; start < locationIds.length; start += LOCATION_CHUNK) {
        statements.push(db.insert(deliveryZoneLocations).values(
            locationIds.slice(start, start + LOCATION_CHUNK).map((locationId) => ({ locationId, zoneId })),
        ));
    }
    return statements;
}

function parseZone(input: DeliveryZoneInput, decimalPlaces: number) {
    const issues: Issue[] = [];
    const name = input.name.trim();
    if (!name) issues.push({ path: ["name"], message: "Enter a zone name." });
    const locationIds = [...new Set(input.locationIds.map((id) => id.trim()).filter(Boolean))];
    if (locationIds.length === 0) {
        issues.push({ path: ["locationIds"], message: "Choose at least one city, zone or area." });
    }
    const rates = parseRates(input.rates, decimalPlaces, issues, true);
    throwIssues(issues);
    return { name, locationIds, rates };
}

/** Every chosen location exists and is not in another zone. */
async function assertLocationsAssignable(db: Database, zoneId: string | null, locationIds: readonly string[]) {
    const rows: Array<{ zoneId: string | null; zoneName: string | null }> = [];
    for (let start = 0; start < locationIds.length; start += 90) {
        rows.push(...await db
            .select({ zoneId: deliveryZones.id, zoneName: deliveryZones.name })
            .from(deliveryLocations)
            .leftJoin(deliveryZoneLocations, eq(deliveryZoneLocations.locationId, deliveryLocations.id))
            .leftJoin(deliveryZones, eq(deliveryZones.id, deliveryZoneLocations.zoneId))
            .where(and(
                inArray(deliveryLocations.id, locationIds.slice(start, start + 90)),
                isNull(deliveryLocations.deletedAt),
            )));
    }
    const fail = (message: string) => {
        throw new ValidationError(message, { issues: [{ path: ["locationIds"], message }] });
    };
    if (rows.length !== locationIds.length) fail("Some of the chosen areas no longer exist. Reload and choose again.");
    const taken = rows.find((row) => row.zoneId && row.zoneId !== zoneId);
    if (taken) fail(`Some of the chosen areas are already in ${taken.zoneName}. Remove them there first.`);
}

function rethrowZoneWriteConflict(error: unknown): never {
    if (error instanceof Error && /UNIQUE|unique constraint|duplicate key/i.test(error.message)) {
        throw new ConflictError("Someone else just changed delivery zones. Reload and try again.");
    }
    throw error;
}

export async function createDeliveryZone(
    db: Database,
    input: DeliveryZoneInput,
    decimalPlaces: number,
): Promise<{ id: string; revision: number }> {
    const zone = parseZone(input, decimalPlaces);
    await assertLocationsAssignable(db, null, zone.locationIds);
    const id = `dz_${nanoid()}`;
    try {
        await safeBatch(db, [
            db.insert(deliveryZones).values({ id, name: zone.name }),
            ...locationStatements(db, id, zone.locationIds),
            ...rateWriteStatements(db, id, zone.rates, []),
        ] as never);
    } catch (error) {
        rethrowZoneWriteConflict(error);
    }
    return { id, revision: 1 };
}

const ZONE_REVISION_GUARD = "DELIVERY_ZONE_REVISION_GUARD";

export async function updateDeliveryZone(
    db: Database,
    id: string,
    input: DeliveryZoneInput,
    expectedRevision: number,
    decimalPlaces: number,
): Promise<{ id: string; revision: number }> {
    const current = await db.select({ revision: deliveryZones.revision }).from(deliveryZones)
        .where(eq(deliveryZones.id, id)).get();
    if (!current) throw new NotFoundError("Delivery zone not found");
    if (current.revision !== expectedRevision) {
        throw new SettingsRevisionConflictError("delivery_zone", expectedRevision, current.revision);
    }
    const zone = parseZone(input, decimalPlaces);
    await assertLocationsAssignable(db, id, zone.locationIds);
    await assertCheckoutKeepsARate(db, id, zone.rates.filter((rate) => rate.isActive).length);
    try {
        await safeBatch(db, [
            // The whole write applies only to the revision the merchant edited.
            buildBatchGuard(
                db,
                sql`EXISTS (SELECT 1 FROM delivery_zones WHERE id = ${id} AND revision = ${expectedRevision})`,
                ZONE_REVISION_GUARD,
            ),
            db.update(deliveryZones)
                .set({ name: zone.name, revision: expectedRevision + 1, updatedAt: now })
                .where(eq(deliveryZones.id, id)),
            ...locationStatements(db, id, zone.locationIds),
            ...rateWriteStatements(db, id, zone.rates, await liveRateIds(db, id)),
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, ZONE_REVISION_GUARD)) {
            const latest = await db.select({ revision: deliveryZones.revision }).from(deliveryZones)
                .where(eq(deliveryZones.id, id)).get();
            throw new SettingsRevisionConflictError("delivery_zone", expectedRevision, latest?.revision ?? 0);
        }
        rethrowZoneWriteConflict(error);
    }
    return { id, revision: expectedRevision + 1 };
}

/** Deletes a zone; its rates are soft-deleted and its areas fall back to Everywhere else. */
export async function deleteDeliveryZone(db: Database, id: string): Promise<void> {
    const existing = await db.select({ id: deliveryZones.id }).from(deliveryZones).where(eq(deliveryZones.id, id)).get();
    if (!existing) throw new NotFoundError("Delivery zone not found");
    await assertCheckoutKeepsARate(db, id, 0);
    await safeBatch(db, [
        db.update(shippingMethods).set({ deletedAt: now, updatedAt: now })
            .where(and(eq(shippingMethods.zoneId, id), isNull(shippingMethods.deletedAt))),
        db.delete(deliveryZones).where(eq(deliveryZones.id, id)),
    ] as never);
}

/** Saves the "Everywhere else" rates against the revision the editor loaded. */
export async function updateEverywhereElseRates(
    db: Database,
    rates: readonly DeliveryRateInput[],
    expectedRevision: number,
    decimalPlaces: number,
): Promise<{ revision: number }> {
    const issues: Issue[] = [];
    const parsed = parseRates(rates, decimalPlaces, issues, false);
    throwIssues(issues);
    await assertCheckoutKeepsARate(db, null, parsed.filter((rate) => rate.isActive).length);
    try {
        const { revision } = await everywhereElseDocument.write(db, {}, undefined, {
            expectedRevision,
            after: rateWriteStatements(db, null, parsed, await liveRateIds(db, null)),
        });
        return { revision };
    } catch (error) {
        rethrowZoneWriteConflict(error);
    }
}

// ── Starter templates (UX-PRINCIPLES E) ────────────────────────────────

export type DeliveryZoneTemplate = "dhaka_two_zone" | "dhaka_three_zone";

const NEAR_DHAKA = ["savar", "gazipur", "narayanganj", "keraniganj"];

/**
 * Creates editable Dhaka-centric zones from the store's own locations: Inside
 * Dhaka (the Dhaka city), for three zones also Near Dhaka (Savar, Gazipur,
 * Narayanganj, Keraniganj where present), and an "Outside Dhaka" rate for
 * everywhere else, which replaces the current Everywhere else rates.
 */
export async function applyDeliveryZoneTemplate(
    db: Database,
    template: DeliveryZoneTemplate,
    expectedRevision: number,
    decimalPlaces: number,
): Promise<void> {
    const existing = await db.select({ id: deliveryZones.id }).from(deliveryZones).limit(1);
    if (existing.length > 0) {
        throw new ConflictError("Templates are for stores without delivery zones. Edit your zones instead.");
    }
    const candidates = await db
        .select({ id: deliveryLocations.id, name: deliveryLocations.name, type: deliveryLocations.type })
        .from(deliveryLocations)
        .where(and(
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
            inArray(deliveryLocations.type, ["city", "zone"]),
            sql`lower(trim(${deliveryLocations.name})) IN ('dhaka', 'savar', 'gazipur', 'narayanganj', 'keraniganj')`,
        ));
    const named = (names: readonly string[], type?: "city") =>
        candidates.filter((row) => names.includes(row.name.trim().toLowerCase()) && (!type || row.type === type));
    const dhaka = named(["dhaka"], "city");
    if (dhaka.length === 0) {
        throw new ValidationError("Add Dhaka to your delivery areas first, or import Bangladesh locations.");
    }
    const nearDhaka = template === "dhaka_three_zone" ? named(NEAR_DHAKA) : [];
    const zones: DeliveryZoneInput[] = [
        {
            name: "Inside Dhaka",
            locationIds: dhaka.map((row) => row.id),
            rates: [{
                name: "Inside Dhaka",
                fee: template === "dhaka_three_zone" ? 70 : 60,
                description: "Delivery in 1–2 days",
                isActive: true,
            }],
        },
        ...(nearDhaka.length > 0 ? [{
            name: "Near Dhaka",
            locationIds: nearDhaka.map((row) => row.id),
            rates: [{ name: "Near Dhaka", fee: 90, description: "Delivery in 2–3 days", isActive: true }],
        }] : []),
    ];
    const everywhereElse = parseRates(
        [{ name: "Outside Dhaka", fee: 120, description: "Delivery in 2–3 days", isActive: true }],
        decimalPlaces,
        [],
        false,
    );
    const zoneStatements = zones.flatMap((input, sortOrder) => {
        const zone = parseZone(input, decimalPlaces);
        const id = `dz_${nanoid()}`;
        return [
            db.insert(deliveryZones).values({ id, name: zone.name, sortOrder }),
            ...locationStatements(db, id, zone.locationIds),
            ...rateWriteStatements(db, id, zone.rates, []),
        ];
    });
    try {
        await everywhereElseDocument.write(db, {}, undefined, {
            expectedRevision,
            after: [
                ...zoneStatements,
                ...rateWriteStatements(db, null, everywhereElse, await liveRateIds(db, null)),
            ],
        });
    } catch (error) {
        rethrowZoneWriteConflict(error);
    }
}
