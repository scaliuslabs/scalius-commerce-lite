/**
 * Tax regions (MARKETS-DESIGN step 3c): the one rule that says which of the
 * merchant's regions an address is in, and which rates of a tax class apply
 * there. Pure and browser-safe: checkout's system provider, the staff order
 * form and the Taxes preview use it. The specificity order is shipping
 * zones' (`delivery/zone-match.ts`).
 *
 * The merchant collects tax only where it has a region (Stripe Tax's rule):
 * an address whose country has no region pays no tax, and no provider is
 * asked. The country region is the registration; its sub-regions (an admin
 * area, a postal prefix or a Bangladesh place) carry the rates that apply
 * there.
 */
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";
import { SYSTEM_TAX_PROVIDER_ID, type TaxRateDefinition, type TaxRegionDefinition } from "./types";

/** An address as tax regions look at it (the tax provider port's destination). */
export interface TaxRegionAddress {
    /** ISO 3166-1 alpha-2. */
    country: string;
    adminArea?: string | null;
    postalCode?: string | null;
    /** Bangladesh's delivery location ids, most specific first (Area, Thana, City). */
    locationIds?: readonly string[];
}

/** A postal code or prefix as regions compare it: upper case, letters and digits only. */
export function normalizeTaxPostalPrefix(value: string | null | undefined): string {
    return typeof value === "string" ? value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/** Whether a region is a whole country (the registration). */
export function isCountryTaxRegion(region: Pick<TaxRegionDefinition, "adminArea" | "postalPrefix" | "placeId">): boolean {
    return !region.adminArea && !region.postalPrefix && !region.placeId;
}

/**
 * The country taxed: the address's (absent with a Bangladesh place:
 * Bangladesh), else, for an order with no address, where the store ships
 * from, else Bangladesh.
 */
export function taxCountryOf(
    destination: { countryCode?: string | null; city?: string | null },
    originCountry?: string | null,
): string {
    return normalizeMarketCountry(destination.countryCode)
        ?? (destination.city ? DELIVERY_HIERARCHY_COUNTRY : null)
        ?? normalizeMarketCountry(originCountry)
        ?? DELIVERY_HIERARCHY_COUNTRY;
}

const sameAdminArea = (left: string, right: string) => left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();

/**
 * The regions an address is in, most specific first:
 *
 * 1. a Bangladesh place: the area's region, then the thana's, then the city's;
 * 2. postal prefixes the postal code starts with, the longest first;
 * 3. the admin area;
 * 4. the whole country.
 *
 * Empty when the country has no region: no tax applies there. Regions of
 * other countries never match.
 */
export function matchTaxRegions(
    address: TaxRegionAddress,
    regions: readonly TaxRegionDefinition[],
): TaxRegionDefinition[] {
    const country = normalizeMarketCountry(address.country);
    const own = regions.filter((region) => region.countryCode === country);
    const countryRegion = own.find(isCountryTaxRegion);
    if (!country || !countryRegion) return [];
    const chain: TaxRegionDefinition[] = [];
    if (country === DELIVERY_HIERARCHY_COUNTRY) {
        for (const id of address.locationIds ?? []) {
            const place = own.find((region) => region.placeId === id);
            if (place) chain.push(place);
        }
    }
    const postalCode = normalizeTaxPostalPrefix(address.postalCode);
    if (postalCode) {
        chain.push(...own
            .filter((region) => region.postalPrefix && postalCode.startsWith(region.postalPrefix))
            .sort((left, right) => right.postalPrefix!.length - left.postalPrefix!.length));
    }
    const adminArea = address.adminArea?.trim();
    if (adminArea) {
        const match = own.find((region) => region.adminArea && sameAdminArea(region.adminArea, adminArea));
        if (match) chain.push(match);
    }
    chain.push(countryRegion);
    return chain;
}

/**
 * The provider that calculates an address's tax: its country region's,
 * else the store-wide one. Null when the country has no region (no tax).
 */
export function taxProviderIdFor(
    chain: readonly TaxRegionDefinition[],
    storeProviderId: string | null | undefined,
): string | null {
    const countryRegion = chain.at(-1);
    if (!countryRegion) return null;
    return countryRegion.providerId ?? storeProviderId ?? SYSTEM_TAX_PROVIDER_ID;
}

/**
 * The rates of a tax class at an address (the system provider's rule): the
 * most specific region with rates of the class applies; when every one of
 * its rates is combinable, the next broader region with rates of the class
 * applies too, and so on. In priority order (then id), as compound layers
 * read them. `regionId` is the most specific region that applied.
 */
export function ratesForTaxClass(
    chain: readonly TaxRegionDefinition[],
    rates: readonly TaxRateDefinition[],
    taxClassId: string,
): { rates: TaxRateDefinition[]; regionId: string | null } {
    const applied: TaxRateDefinition[] = [];
    let regionId: string | null = null;
    for (const region of chain) {
        const own = rates.filter((rate) => rate.taxRegionId === region.id && rate.taxClassId === taxClassId);
        if (own.length === 0) continue;
        regionId ??= region.id;
        applied.push(...own);
        if (!own.every((rate) => rate.combinable)) break;
    }
    applied.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    return { rates: applied, regionId };
}
