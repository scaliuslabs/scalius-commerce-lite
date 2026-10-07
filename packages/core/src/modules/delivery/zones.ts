/**
 * Shipping zones and their rates (Shopify's shipping zones, MARKETS-DESIGN
 * step 3b).
 *
 * A zone is a name, the regions it serves (whole countries, admin areas,
 * postal-code prefixes) and the Bangladesh delivery locations it holds
 * (cities, thanas, areas). A region and a location each belong to at most one
 * zone. An address belongs to its most specific matching zone
 * (`resolveDestinationZoneId`, zone-match.ts); an address no zone matches gets
 * no delivery rate. A delivery rate (a `shipping_methods` row) belongs to one
 * zone and can be free once the items subtotal, before discounts, reaches a
 * threshold. Local pickup is store-wide (no zone) and offered to every buyer.
 * Zones serve countries, not markets. Checkout never trusts a client fee:
 * `resolveDeliveryRate` is the one place that decides whether a rate applies
 * and what it costs.
 */
import { z } from "zod";
import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import { deps } from "../../cache-deps";
import { matchAdminArea } from "@scalius/shared/address";
import { addressRulesFor } from "@scalius/shared/address-metadata";
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    deliveryZoneLocations,
    deliveryZoneRegions,
    deliveryZones,
    placeAddressFieldSql,
    places,
    shippingMethods,
} from "@scalius/database/schema";
import { fromMinor, isIncrementMultipleMinor, priceIncrementMessage, toMinor } from "@scalius/shared/money";
import type { StoreCurrency } from "../settings";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { defineSettingsDocument, SettingsRevisionConflictError } from "../../settings-store";
import {
    deliveryCoverageFactsFromText,
    destinationCountry,
    MAX_POSTAL_PREFIX_LENGTH,
    normalizePostalPrefix,
    resolveDestinationZoneId,
    zoneCountryCoverage,
    type DeliveryCountryCoverage,
    type DeliveryDestination,
    type DeliveryRegionRow,
} from "./zone-match";
import { addressPlaceCountrySql } from "./places";

type Statement = BatchItem<"sqlite">;

/** Largest charge or free-over threshold, in major units (৳1,00,000). */
export const MAX_DELIVERY_AMOUNT = 100_000;
export const MAX_ZONE_RATES = 20;
export const MAX_ZONE_LOCATIONS = 2_000;
/** Countries, admin areas and postal prefixes of one zone. */
export const MAX_ZONE_REGIONS = 500;

export type DeliveryRateKind = "delivery" | "pickup";

// D1 binds at most 100 parameters per statement.
const LOCATION_CHUNK = 45;
const REGION_CHUNK = 20;
const now = sql`(cast(strftime('%s','now') as int))`;

// ── Destinations ───────────────────────────────────────────────────────

/**
 * A destination as zones compare it: an ISO country (Bangladesh when absent),
 * Bangladesh's location ids only in Bangladesh, a known admin area as its
 * rules' code, and the postal code without spaces in upper case.
 */
export function normalizeDeliveryDestination(input: DeliveryDestination): DeliveryDestination & { countryCode: string } {
    const countryCode = destinationCountry(input);
    const text = (value: string | null | undefined) => (typeof value === "string" && value.trim() ? value.trim() : null);
    if (countryCode === DELIVERY_HIERARCHY_COUNTRY) {
        return { countryCode, city: text(input.city), zone: text(input.zone), area: text(input.area), adminArea: null, postalCode: null };
    }
    const adminArea = text(input.adminArea);
    const rules = adminArea ? addressRulesFor(countryCode) : null;
    return {
        countryCode,
        city: null,
        zone: null,
        area: null,
        adminArea: adminArea ? (rules ? matchAdminArea(rules, adminArea)?.code ?? adminArea : adminArea) : null,
        postalCode: normalizePostalPrefix(input.postalCode) || null,
    };
}

/** Region rows as a JSON text column: `[{ "zoneId", "countryCode", "adminArea", "postalPrefix" }]`. */
function regionRowsJsonSql(countries: readonly string[]): SQL<string | null> {
    return sql<string | null>`(SELECT '[' || group_concat(json_object('zoneId', destination_region.zone_id, 'countryCode', destination_region.country_code, 'adminArea', destination_region.admin_area, 'postalPrefix', destination_region.postal_prefix), ',') || ']' FROM ${deliveryZoneRegions} AS destination_region WHERE destination_region.country_code IN ${countries})`;
}

/** The region rows of a `regionRowsJsonSql()` value. */
export function parseDeliveryRegionRows(value: unknown): DeliveryRegionRow[] {
    if (typeof value !== "string" || !value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: { zoneId?: unknown; countryCode?: unknown; adminArea?: unknown; postalPrefix?: unknown }) =>
        typeof entry?.zoneId === "string" && typeof entry.countryCode === "string"
            ? [{
                zoneId: entry.zoneId,
                countryCode: entry.countryCode,
                adminArea: typeof entry.adminArea === "string" && entry.adminArea ? entry.adminArea : null,
                postalPrefix: typeof entry.postalPrefix === "string" && entry.postalPrefix ? entry.postalPrefix : null,
            }]
            : []);
}

// ── Checkout: the one rate resolution ──────────────────────────────────

export interface DeliveryRateRow {
    id: string;
    /** Null for local pickup. */
    zoneId: string | null;
    name: string;
    description: string | null;
    feeMinor: number;
    freeOverMinor: number | null;
    isActive: boolean;
    deletedAt?: Date | number | null;
    kind?: DeliveryRateKind;
    /** Where and when a pickup rate's orders are collected (snapshotted on the order). */
    pickupAddress?: string | null;
    pickupHours?: string | null;
    /**
     * The regions of the destination countries asked for (a JSON text), read
     * in the statement checkout already runs for the rate: with the location
     * rows' zones, they pick the destination's zone.
     */
    destinationRegions?: string | null;
}

/**
 * Live, active rates by id. With `destinationCountries`, each row also
 * carries those countries' zone regions (`destinationRegions`), so checkout
 * resolves the destination's zone without another statement.
 */
export function selectDeliveryRateRowsByIds(
    db: Database,
    rawIds: readonly string[],
    destinationCountries: readonly string[] = [],
) {
    const ids = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))];
    const countries = [...new Set(destinationCountries.map((code) => normalizeMarketCountry(code)).filter((code): code is string => Boolean(code)))].sort();
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
            pickupAddress: shippingMethods.pickupAddress,
            pickupHours: shippingMethods.pickupHours,
            destinationRegions: countries.length > 0 ? regionRowsJsonSql(countries) : sql<string | null>`NULL`,
        })
        .from(shippingMethods);
    if (ids.length === 0) return query.limit(0);
    return query.where(and(
        inArray(shippingMethods.id, ids),
        eq(shippingMethods.isActive, true),
        isNull(shippingMethods.deletedAt),
    ));
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
 * Verifies the chosen rate is live, active, well formed and a rate of the
 * destination's zone (local pickup is offered everywhere), then applies its
 * free-over threshold to the items subtotal. `addressZoneId` null: no zone
 * serves the destination, so no delivery rate does (fail closed).
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
    if (kind === "delivery" && addressZoneId === null) {
        throw new ValidationError(
            "We don't deliver to this address. Choose pickup if it is offered, or another address.",
            { reason: DELIVERY_RATE_UNAVAILABLE_REASON },
        );
    }
    if (kind === "delivery" && rate.zoneId !== addressZoneId) {
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

// ── Storefront: rates for a destination ────────────────────────────────

/**
 * The zone candidates of one destination in ONE statement: the zones of its
 * Bangladesh locations and its country's regions. `resolveDestinationZoneId`
 * picks from them.
 */
function selectDestinationZoneCandidates(db: Database, destination: DeliveryDestination & { countryCode: string }) {
    const regions = db
        .select({
            zoneId: deliveryZoneRegions.zoneId,
            locationId: sql<string | null>`NULL`,
            countryCode: deliveryZoneRegions.countryCode,
            adminArea: deliveryZoneRegions.adminArea,
            postalPrefix: deliveryZoneRegions.postalPrefix,
        })
        .from(deliveryZoneRegions)
        .where(eq(deliveryZoneRegions.countryCode, destination.countryCode));
    const locationIds = [destination.city, destination.zone, destination.area].filter((id): id is string => Boolean(id));
    if (locationIds.length === 0) return regions;
    const locations = db
        .select({
            zoneId: deliveryZoneLocations.zoneId,
            locationId: sql<string | null>`${deliveryZoneLocations.locationId}`,
            countryCode: sql<string>`'BD'`,
            adminArea: sql<string>`''`,
            postalPrefix: sql<string>`''`,
        })
        .from(deliveryZoneLocations)
        .where(inArray(deliveryZoneLocations.locationId, locationIds));
    return unionAll(locations, regions);
}

/**
 * Every zone's countries and which zones hold Bangladesh locations, as one
 * scalar text (`deliveryCoverageFactsFromText`), for the statement a rate
 * read already runs.
 */
function coverageFactsSql(): SQL<string | null> {
    return sql<string | null>`(SELECT group_concat(coverage.entry, ',') FROM (
        SELECT DISTINCT coverage_region.zone_id || ':' || coverage_region.country_code || ':' || CASE WHEN coverage_region.admin_area = '' AND coverage_region.postal_prefix = '' THEN 'c' ELSE 'p' END AS entry
        FROM ${deliveryZoneRegions} AS coverage_region
        UNION
        SELECT DISTINCT coverage_location.zone_id || ':BD:l' AS entry FROM ${deliveryZoneLocations} AS coverage_location
    ) AS coverage)`;
}

export interface OfferedDeliveryRate {
    id: string;
    /** Null for local pickup. */
    zoneId: string | null;
    name: string;
    description: string | null;
    feeMinor: number;
    freeOverMinor: number | null;
    kind: DeliveryRateKind;
    pickupAddress: string | null;
    pickupHours: string | null;
    isActive: boolean;
    sortOrder: number;
    createdAt: Date | null;
    updatedAt: Date | null;
    /**
     * The countries the rate's zone serves, each marked `entire` when every
     * address there gets this zone. Empty for local pickup.
     */
    countries: DeliveryCountryCoverage[];
}

/**
 * Live, active rates offered at checkout. With a destination, only the rates
 * of the zone it belongs to plus local pickup (no delivery rate means the
 * store doesn't deliver there); without one, every active rate. Each rate
 * says which countries its zone serves.
 */
export async function listDeliveryRatesForDestination(
    db: Database,
    input: DeliveryDestination | null,
): Promise<OfferedDeliveryRate[]> {
    deps.shipping();
    const conditions: SQL[] = [eq(shippingMethods.isActive, true), isNull(shippingMethods.deletedAt)];
    if (input) {
        const destination = normalizeDeliveryDestination(input);
        const candidates = await selectDestinationZoneCandidates(db, destination);
        const zoneId = resolveDestinationZoneId(destination, {
            locations: candidates.flatMap((row) => (row.locationId ? [{ id: row.locationId, deliveryZoneId: row.zoneId }] : [])),
            regions: candidates.flatMap((row) => (row.locationId
                ? []
                : [{ zoneId: row.zoneId, countryCode: row.countryCode, adminArea: row.adminArea || null, postalPrefix: row.postalPrefix || null }])),
        });
        conditions.push(zoneId
            ? or(eq(shippingMethods.zoneId, zoneId), eq(shippingMethods.kind, "pickup"))!
            : eq(shippingMethods.kind, "pickup"));
    }
    const rows = await db
        .select({
            id: shippingMethods.id,
            zoneId: shippingMethods.zoneId,
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
            coverage: coverageFactsSql(),
        })
        .from(shippingMethods)
        .where(and(...conditions))
        .orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.name));
    const facts = deliveryCoverageFactsFromText(rows[0]?.coverage);
    return rows.map(({ coverage: _coverage, ...row }) => ({
        ...row,
        countries: row.zoneId ? zoneCountryCoverage(row.zoneId, facts) : [],
    }));
}

// ── Dashboard: zones and local pickup ──────────────────────────────────

/**
 * Local pickup has no zone row; this empty settings document carries its
 * revision so two staff editing pickup can't overwrite each other.
 */
const pickupDocument = defineSettingsDocument<Record<string, never>>({
    key: "delivery_pickup",
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

export interface DeliveryZoneRegionView {
    countryCode: string;
    /** Null with a null postal prefix: the whole country. */
    adminArea: string | null;
    postalPrefix: string | null;
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
    /** Countries, admin areas and postal prefixes, sorted. */
    regions: DeliveryZoneRegionView[];
    /** Bangladesh delivery locations. */
    locations: DeliveryZoneLocationView[];
    rates: DeliveryRateView[];
}

export interface DeliveryZonesView {
    zones: DeliveryZoneView[];
    pickup: { revision: number; rates: DeliveryRateView[] };
}

export async function listDeliveryZones(db: Database, decimalPlaces: number): Promise<DeliveryZonesView> {
    const parent = alias(places, "parent_location");
    const grandparent = alias(places, "grandparent_location");
    const [zones, regions, locations, rates, pickup] = await Promise.all([
        db.select().from(deliveryZones).orderBy(asc(deliveryZones.sortOrder), asc(deliveryZones.createdAt)),
        db.select().from(deliveryZoneRegions)
            .orderBy(asc(deliveryZoneRegions.countryCode), asc(deliveryZoneRegions.adminArea), asc(deliveryZoneRegions.postalPrefix)),
        db
            .select({
                zoneId: deliveryZoneLocations.zoneId,
                id: places.id,
                name: places.name,
                type: placeAddressFieldSql,
                parentName: parent.name,
                grandparentName: grandparent.name,
            })
            .from(deliveryZoneLocations)
            .innerJoin(places, eq(places.id, deliveryZoneLocations.locationId))
            .leftJoin(parent, eq(parent.id, places.parentId))
            .leftJoin(grandparent, eq(grandparent.id, parent.parentId))
            .where(isNull(places.deletedAt))
            .orderBy(asc(places.name)),
        db.select().from(shippingMethods).where(isNull(shippingMethods.deletedAt))
            .orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.name)),
        pickupDocument.readDetailed(db, {}, { skipCache: true }),
    ]);
    const ratesOf = (zoneId: string | null): DeliveryRateView[] => rates
        .filter((rate) => (rate.zoneId ?? null) === zoneId && (zoneId !== null || rate.kind === "pickup"))
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
            regions: regions
                .filter((region) => region.zoneId === zone.id)
                .map((region) => ({
                    countryCode: region.countryCode,
                    adminArea: region.adminArea || null,
                    postalPrefix: region.postalPrefix || null,
                })),
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
        pickup: { revision: pickup.revision, rates: ratesOf(null) },
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

/** One region of a zone: a whole country, or one admin area or postal prefix of it. */
export interface DeliveryZoneRegionInput {
    countryCode: string;
    adminArea?: string | null;
    postalPrefix?: string | null;
}

export interface DeliveryZoneInput {
    name: string;
    /** Countries, admin areas and postal prefixes. */
    regions?: DeliveryZoneRegionInput[];
    /** Bangladesh delivery locations (cities, thanas, areas). */
    locationIds?: string[];
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

interface ParsedRegion {
    countryCode: string;
    adminArea: string;
    postalPrefix: string;
}

function amountToMinor(value: number, currency: StoreCurrency, path: Issue["path"], issues: Issue[]): number {
    if (!Number.isFinite(value) || value < 0 || value > MAX_DELIVERY_AMOUNT) {
        issues.push({ path, message: "Enter an amount from 0 to 1,00,000." });
        return 0;
    }
    const minor = toMinor(value, currency.decimalPlaces);
    if (fromMinor(minor, currency.decimalPlaces) !== value) {
        issues.push({ path, message: `Use up to ${currency.decimalPlaces} decimal places.` });
    } else if (!isIncrementMultipleMinor(minor, currency.priceIncrementMinor)) {
        // A delivery charge or threshold is a price: on the store's increment
        // (a BDT store's default, whole taka, is also what riders collect).
        issues.push({ path, message: priceIncrementMessage(currency.code, currency.priceIncrementMinor) });
    }
    return minor;
}

function parseRates(
    rates: readonly DeliveryRateInput[],
    currency: StoreCurrency,
    issues: Issue[],
    scope: "zone" | "pickup",
): ParsedRate[] {
    const seen = new Set<string>();
    return rates.map((rate, index) => {
        const kind = scope === "pickup" ? "pickup" : rate.kind ?? "delivery";
        const pickupAddress = kind === "pickup" ? rate.pickupAddress?.trim() || null : null;
        const pickupHours = kind === "pickup" ? rate.pickupHours?.trim() || null : null;
        if (kind === "pickup" && scope === "zone") {
            issues.push({ path: ["rates", index, "kind"], message: "Add pickup under Local pickup: it's offered to every buyer." });
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
            feeMinor: amountToMinor(rate.fee, currency, ["rates", index, "fee"], issues),
            freeOverMinor: freeOver === null
                ? null
                : amountToMinor(freeOver, currency, ["rates", index, "freeOver"], issues),
            description: rate.description?.trim() || null,
            isActive: rate.isActive,
        };
    });
}

/**
 * The zone's regions, deduplicated: a known country, an admin area of its
 * address rules (stored as the rules' code), or a postal prefix of letters
 * and digits. Bangladesh is served whole or through its delivery locations.
 */
function parseRegions(regions: readonly DeliveryZoneRegionInput[], issues: Issue[]): ParsedRegion[] {
    const parsed = new Map<string, ParsedRegion>();
    regions.forEach((input, index) => {
        const path = ["regions", index];
        const countryCode = normalizeMarketCountry(input.countryCode);
        const rules = countryCode ? addressRulesFor(countryCode) : null;
        if (!countryCode || !rules) {
            issues.push({ path: [...path, "countryCode"], message: "Choose a country from the list." });
            return;
        }
        const adminAreaText = input.adminArea?.trim() || "";
        const postalText = input.postalPrefix?.trim() || "";
        if (adminAreaText && postalText) {
            issues.push({ path, message: "Choose a region or a postal code prefix, not both." });
            return;
        }
        if (countryCode === DELIVERY_HIERARCHY_COUNTRY && (adminAreaText || postalText)) {
            issues.push({ path, message: "Choose Bangladesh cities, thanas or areas under Delivery areas." });
            return;
        }
        let adminArea = "";
        if (adminAreaText) {
            const match = matchAdminArea(rules, adminAreaText);
            if (!match) {
                issues.push({ path: [...path, "adminArea"], message: "Choose a region from the list." });
                return;
            }
            adminArea = match.code;
        }
        const postalPrefix = normalizePostalPrefix(postalText);
        if (postalText && (!postalPrefix || postalPrefix.length > MAX_POSTAL_PREFIX_LENGTH)) {
            issues.push({ path: [...path, "postalPrefix"], message: `Enter 1 to ${MAX_POSTAL_PREFIX_LENGTH} letters or digits.` });
            return;
        }
        parsed.set(`${countryCode}|${adminArea}|${postalPrefix}`, { countryCode, adminArea, postalPrefix });
    });
    if (parsed.size > MAX_ZONE_REGIONS) {
        issues.push({ path: ["regions"], message: `Use ${MAX_ZONE_REGIONS} countries, regions and postal codes or fewer.` });
    }
    return [...parsed.values()];
}

function throwIssues(issues: readonly Issue[]): void {
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });
}

/** A zone's rates, or local pickup's (`null`). */
function rateScope(zoneId: string | null): SQL {
    return zoneId
        ? eq(shippingMethods.zoneId, zoneId)
        : and(isNull(shippingMethods.zoneId), eq(shippingMethods.kind, "pickup"))!;
}

async function liveRateIds(db: Database, zoneId: string | null): Promise<string[]> {
    const rows = await db.select({ id: shippingMethods.id }).from(shippingMethods)
        .where(and(rateScope(zoneId), isNull(shippingMethods.deletedAt)));
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
                rateScope(zoneId),
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

function regionStatements(db: Database, zoneId: string, regions: readonly ParsedRegion[]): Statement[] {
    const statements: Statement[] = [db.delete(deliveryZoneRegions).where(eq(deliveryZoneRegions.zoneId, zoneId))];
    for (let start = 0; start < regions.length; start += REGION_CHUNK) {
        statements.push(db.insert(deliveryZoneRegions).values(
            regions.slice(start, start + REGION_CHUNK).map((region) => ({ ...region, zoneId })),
        ));
    }
    return statements;
}

function parseZone(input: DeliveryZoneInput, currency: StoreCurrency) {
    const issues: Issue[] = [];
    const name = input.name.trim();
    if (!name) issues.push({ path: ["name"], message: "Enter a zone name." });
    const regions = parseRegions(input.regions ?? [], issues);
    const locationIds = [...new Set((input.locationIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (regions.length === 0 && locationIds.length === 0 && !issues.some((issue) => issue.path[0] === "regions")) {
        issues.push({ path: ["regions"], message: "Choose at least one country, region or delivery area." });
    }
    if (locationIds.length > 0 && regions.some((region) => region.countryCode === DELIVERY_HIERARCHY_COUNTRY)) {
        issues.push({ path: ["locationIds"], message: "Choose all of Bangladesh or some of its delivery areas, not both." });
    }
    const rates = parseRates(input.rates, currency, issues, "zone");
    throwIssues(issues);
    return { name, regions, locationIds, rates };
}

/** Every chosen location exists and is not in another zone. */
async function assertLocationsAssignable(db: Database, zoneId: string | null, locationIds: readonly string[]) {
    const rows: Array<{ zoneId: string | null; zoneName: string | null }> = [];
    for (let start = 0; start < locationIds.length; start += 90) {
        rows.push(...await db
            .select({ zoneId: deliveryZones.id, zoneName: deliveryZones.name })
            .from(places)
            .leftJoin(deliveryZoneLocations, eq(deliveryZoneLocations.locationId, places.id))
            .leftJoin(deliveryZones, eq(deliveryZones.id, deliveryZoneLocations.zoneId))
            .where(and(
                inArray(places.id, locationIds.slice(start, start + 90)),
                // A zone holds Bangladesh places: the addresses that carry place ids.
                addressPlaceCountrySql,
                isNull(places.deletedAt),
            )));
    }
    const fail = (message: string) => {
        throw new ValidationError(message, { issues: [{ path: ["locationIds"], message }] });
    };
    if (rows.length !== locationIds.length) fail("Some of the chosen areas no longer exist. Reload and choose again.");
    const taken = rows.find((row) => row.zoneId && row.zoneId !== zoneId);
    if (taken) fail(`Some of the chosen areas are already in ${taken.zoneName}. Remove them there first.`);
}

/** No chosen region is in another zone (one zone per region). */
async function assertRegionsAssignable(db: Database, zoneId: string | null, regions: readonly ParsedRegion[]) {
    const countries = [...new Set(regions.map((region) => region.countryCode))];
    if (countries.length === 0) return;
    const held = await db
        .select({
            countryCode: deliveryZoneRegions.countryCode,
            adminArea: deliveryZoneRegions.adminArea,
            postalPrefix: deliveryZoneRegions.postalPrefix,
            zoneId: deliveryZoneRegions.zoneId,
            zoneName: deliveryZones.name,
        })
        .from(deliveryZoneRegions)
        .innerJoin(deliveryZones, eq(deliveryZones.id, deliveryZoneRegions.zoneId))
        .where(inArray(deliveryZoneRegions.countryCode, countries));
    const owner = new Map(held
        .filter((row) => row.zoneId !== zoneId)
        .map((row) => [`${row.countryCode}|${row.adminArea}|${row.postalPrefix}`, row.zoneName]));
    const index = regions.findIndex((region) => owner.has(`${region.countryCode}|${region.adminArea}|${region.postalPrefix}`));
    if (index < 0) return;
    const region = regions[index]!;
    const what = region.postalPrefix
        ? `Postal codes starting ${region.postalPrefix} (${region.countryCode})`
        : region.adminArea ? `${region.adminArea} (${region.countryCode})` : region.countryCode;
    const message = `${what} is already in ${owner.get(`${region.countryCode}|${region.adminArea}|${region.postalPrefix}`)}. Remove it there first.`;
    throw new ValidationError(message, { issues: [{ path: ["regions"], message }] });
}

function rethrowZoneWriteConflict(error: unknown): never {
    if (error instanceof Error && /UNIQUE|unique constraint|duplicate key/i.test(error.message)) {
        throw new ConflictError("Someone else just changed shipping zones. Reload and try again.");
    }
    throw error;
}

function zoneStatements(db: Database, id: string, zone: ReturnType<typeof parseZone>, currentRateIds: readonly string[]): Statement[] {
    return [
        ...regionStatements(db, id, zone.regions),
        ...locationStatements(db, id, zone.locationIds),
        ...rateWriteStatements(db, id, zone.rates, currentRateIds),
    ];
}

export async function createDeliveryZone(
    db: Database,
    input: DeliveryZoneInput,
    currency: StoreCurrency,
): Promise<{ id: string; revision: number }> {
    const zone = parseZone(input, currency);
    await assertLocationsAssignable(db, null, zone.locationIds);
    await assertRegionsAssignable(db, null, zone.regions);
    const id = `dz_${nanoid()}`;
    try {
        await safeBatch(db, [
            db.insert(deliveryZones).values({
                id,
                name: zone.name,
                // After the existing zones.
                sortOrder: sql`(SELECT coalesce(max(${deliveryZones.sortOrder}), -1) + 1 FROM ${deliveryZones})`,
            }),
            ...zoneStatements(db, id, zone, []),
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
    currency: StoreCurrency,
): Promise<{ id: string; revision: number }> {
    const current = await db.select({ revision: deliveryZones.revision }).from(deliveryZones)
        .where(eq(deliveryZones.id, id)).get();
    if (!current) throw new NotFoundError("Shipping zone not found");
    if (current.revision !== expectedRevision) {
        throw new SettingsRevisionConflictError("delivery_zone", expectedRevision, current.revision);
    }
    const zone = parseZone(input, currency);
    await assertLocationsAssignable(db, id, zone.locationIds);
    await assertRegionsAssignable(db, id, zone.regions);
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
            ...zoneStatements(db, id, zone, await liveRateIds(db, id)),
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

/** Deletes a zone; its rates are soft-deleted and its addresses fall to the next matching zone, or none. */
export async function deleteDeliveryZone(db: Database, id: string): Promise<void> {
    const existing = await db.select({ id: deliveryZones.id }).from(deliveryZones).where(eq(deliveryZones.id, id)).get();
    if (!existing) throw new NotFoundError("Shipping zone not found");
    await assertCheckoutKeepsARate(db, id, 0);
    await safeBatch(db, [
        db.update(shippingMethods).set({ deletedAt: now, updatedAt: now })
            .where(and(eq(shippingMethods.zoneId, id), isNull(shippingMethods.deletedAt))),
        db.delete(deliveryZones).where(eq(deliveryZones.id, id)),
    ] as never);
}

/** Saves the local pickup rates against the revision the editor loaded. */
export async function updatePickupRates(
    db: Database,
    rates: readonly DeliveryRateInput[],
    expectedRevision: number,
    currency: StoreCurrency,
): Promise<{ revision: number }> {
    const issues: Issue[] = [];
    const parsed = parseRates(rates, currency, issues, "pickup");
    throwIssues(issues);
    await assertCheckoutKeepsARate(db, null, parsed.filter((rate) => rate.isActive).length);
    try {
        const { revision } = await pickupDocument.write(db, {}, undefined, {
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
const TEMPLATE_GUARD = "DELIVERY_ZONE_TEMPLATE_GUARD";

/**
 * Creates editable Dhaka-centric zones from the store's own locations: Inside
 * Dhaka (the Dhaka city), for three zones also Near Dhaka (Savar, Gazipur,
 * Narayanganj, Keraniganj where present), and the zone Bangladesh (the whole
 * country) with an "Outside Dhaka" rate. Only for a store without zones.
 */
export async function applyDeliveryZoneTemplate(
    db: Database,
    template: DeliveryZoneTemplate,
    currency: StoreCurrency,
): Promise<void> {
    const existing = await db.select({ id: deliveryZones.id }).from(deliveryZones).limit(1);
    if (existing.length > 0) {
        throw new ConflictError("Templates are for stores without shipping zones. Edit your zones instead.");
    }
    const candidates = await db
        .select({ id: places.id, name: places.name, type: placeAddressFieldSql })
        .from(places)
        .where(and(
            addressPlaceCountrySql,
            eq(places.isActive, true),
            isNull(places.deletedAt),
            inArray(places.level, [1, 2]),
            sql`lower(trim(${places.name})) IN ('dhaka', 'savar', 'gazipur', 'narayanganj', 'keraniganj')`,
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
        {
            name: "Bangladesh",
            regions: [{ countryCode: DELIVERY_HIERARCHY_COUNTRY }],
            rates: [{ name: "Outside Dhaka", fee: 120, description: "Delivery in 2–3 days", isActive: true }],
        },
    ];
    const statements = zones.flatMap((input, sortOrder) => {
        const zone = parseZone(input, currency);
        const id = `dz_${nanoid()}`;
        return [db.insert(deliveryZones).values({ id, name: zone.name, sortOrder }), ...zoneStatements(db, id, zone, [])];
    });
    try {
        await safeBatch(db, [
            // Two staff applying a template at once: only the first creates zones.
            buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM delivery_zones)`, TEMPLATE_GUARD),
            ...statements,
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, TEMPLATE_GUARD)) {
            throw new ConflictError("Templates are for stores without shipping zones. Edit your zones instead.");
        }
        rethrowZoneWriteConflict(error);
    }
}
