/**
 * Shipping zones by region (MARKETS-DESIGN step 3b, Shopify's model): the one
 * rule that picks an address's zone, and the one rule that says where a
 * zone's rates apply to every address of a country. Pure and browser-safe:
 * checkout, the storefront rate read, discovery and the staff order form all
 * use these functions.
 *
 * A zone serves regions (`delivery_zone_regions`: a whole country, one admin
 * area of it, or postal codes that start with a prefix) and Bangladesh
 * delivery locations (`delivery_zone_locations`). A region and a location
 * each belong to at most one zone.
 */
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";

/** One region a zone serves; null admin area and postal prefix: the whole country. */
export interface DeliveryZoneRegion {
    countryCode: string;
    /** The admin area code of the country's address rules (`CA`, `NSW`). */
    adminArea: string | null;
    /** Upper-case letters and digits (`SW1`, `941`). */
    postalPrefix: string | null;
}

export interface DeliveryRegionRow extends DeliveryZoneRegion {
    zoneId: string;
}

/** Where an order is delivered, as far as zones look at it. */
export interface DeliveryDestination {
    /** ISO 3166-1 alpha-2; absent: Bangladesh. */
    countryCode?: string | null;
    /** Bangladesh's City/Thana/Area location ids. */
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    /** Another country's admin area (its address rules' code) and postal code. */
    adminArea?: string | null;
    postalCode?: string | null;
}

/** What a destination's zone is picked from: its locations' zones and its country's regions. */
export interface DeliveryZoneCandidates {
    locations: readonly { id: string; deliveryZoneId?: string | null }[];
    regions: readonly DeliveryRegionRow[];
}

/** Longest postal prefix a zone may hold. */
export const MAX_POSTAL_PREFIX_LENGTH = 10;

/** A postal code or prefix as zones compare it: upper case, letters and digits only. */
export function normalizePostalPrefix(value: string | null | undefined): string {
    return typeof value === "string" ? value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/** The destination's country, Bangladesh when absent. */
export function destinationCountry(destination: Pick<DeliveryDestination, "countryCode"> | null | undefined): string {
    return normalizeMarketCountry(destination?.countryCode) ?? DELIVERY_HIERARCHY_COUNTRY;
}

function sameAdminArea(left: string, right: string): boolean {
    return left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

/**
 * The zone of a destination: the most specific match wins.
 *
 * 1. A Bangladesh location: the area's zone, else the thana's, else the city's.
 * 2. A postal prefix of the destination's country that its postal code
 *    starts with (the longest prefix wins).
 * 3. The destination's admin area.
 * 4. The whole country.
 *
 * Null: no zone serves the destination, so no delivery rate applies (pickup
 * still does). Regions of other countries never match.
 */
export function resolveDestinationZoneId(
    destination: DeliveryDestination,
    candidates: DeliveryZoneCandidates,
): string | null {
    const country = destinationCountry(destination);
    if (country === DELIVERY_HIERARCHY_COUNTRY) {
        const zoneOf = new Map(candidates.locations.map((row) => [row.id, row.deliveryZoneId ?? null]));
        for (const id of [destination.area, destination.zone, destination.city]) {
            const zoneId = id ? zoneOf.get(id) : null;
            if (zoneId) return zoneId;
        }
    }
    const regions = candidates.regions.filter((region) => region.countryCode === country);
    const postalCode = normalizePostalPrefix(destination.postalCode);
    if (postalCode) {
        let best: DeliveryRegionRow | null = null;
        for (const region of regions) {
            const prefix = region.postalPrefix ?? "";
            if (prefix && postalCode.startsWith(prefix) && prefix.length > (best?.postalPrefix?.length ?? 0)) best = region;
        }
        if (best) return best.zoneId;
    }
    const adminArea = destination.adminArea?.trim();
    if (adminArea) {
        const match = regions.find((region) => region.adminArea && sameAdminArea(region.adminArea, adminArea));
        if (match) return match.zoneId;
    }
    return regions.find((region) => !region.adminArea && !region.postalPrefix)?.zoneId ?? null;
}

/** A country a zone's rates are offered in, and whether at every address there. */
export interface DeliveryCountryCoverage {
    code: string;
    /**
     * True when every address of the country gets this zone: the zone holds
     * the whole country and no other zone holds a part of it (a more
     * specific match would win there).
     */
    entire: boolean;
}

/** The facts coverage is computed from: every zone's countries, and which zones hold Bangladesh locations. */
export interface DeliveryCoverageFacts {
    /** One entry per zone and country: `whole` when the zone holds the whole country. */
    regions: readonly { zoneId: string; countryCode: string; whole: boolean }[];
    /** Zones that hold at least one Bangladesh location. */
    locationZoneIds: ReadonlySet<string>;
}

/** The countries a zone serves, sorted, each with whether it serves the whole of it. */
export function zoneCountryCoverage(zoneId: string, facts: DeliveryCoverageFacts): DeliveryCountryCoverage[] {
    const countries = new Map<string, boolean>();
    for (const region of facts.regions) {
        if (region.zoneId !== zoneId) continue;
        countries.set(region.countryCode, (countries.get(region.countryCode) ?? false) || region.whole);
    }
    if (facts.locationZoneIds.has(zoneId) && !countries.has(DELIVERY_HIERARCHY_COUNTRY)) {
        countries.set(DELIVERY_HIERARCHY_COUNTRY, false);
    }
    return [...countries.entries()]
        .map(([code, whole]) => {
            const othersHoldPart = facts.regions.some((region) => region.countryCode === code && region.zoneId !== zoneId)
                || (code === DELIVERY_HIERARCHY_COUNTRY && [...facts.locationZoneIds].some((id) => id !== zoneId));
            return { code, entire: whole && !othersHoldPart };
        })
        .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
}

/**
 * The coverage facts as one compact SQL text (`zone:country:c|p|l`, comma
 * separated): `c` the whole country, `p` part of it (an admin area or a
 * postal prefix), `l` Bangladesh locations. Zone ids are `dz_<nanoid>` and
 * country codes two letters, so the list is unambiguous.
 */
export function deliveryCoverageFactsFromText(value: unknown): DeliveryCoverageFacts {
    const regions: Array<{ zoneId: string; countryCode: string; whole: boolean }> = [];
    const locationZoneIds = new Set<string>();
    if (typeof value === "string") {
        for (const entry of value.split(",")) {
            const [zoneId, countryCode, kind] = entry.split(":");
            if (!zoneId || !countryCode) continue;
            if (kind === "l") locationZoneIds.add(zoneId);
            else regions.push({ zoneId, countryCode, whole: kind === "c" });
        }
    }
    return { regions, locationZoneIds };
}
