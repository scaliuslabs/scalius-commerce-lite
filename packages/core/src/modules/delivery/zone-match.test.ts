import { describe, expect, it } from "vitest";
import {
    deliveryCoverageFactsFromText,
    normalizePostalPrefix,
    resolveDestinationZoneId,
    zoneCountryCoverage,
    type DeliveryRegionRow,
} from "./zone-match";

const region = (zoneId: string, countryCode: string, adminArea: string | null = null, postalPrefix: string | null = null): DeliveryRegionRow =>
    ({ zoneId, countryCode, adminArea, postalPrefix });

describe("resolveDestinationZoneId: the most specific match wins", () => {
    const regions = [
        region("dz_bd", "BD"),
        region("dz_us", "US"),
        region("dz_west", "US", "CA"),
        region("dz_west", "US", "OR"),
        region("dz_sf", "US", null, "941"),
        region("dz_sf_core", "US", null, "9410"),
        region("dz_london", "GB", null, "SW1"),
    ];
    const locations = [
        { id: "city_dhaka", deliveryZoneId: "dz_dhaka" },
        { id: "zone_mirpur", deliveryZoneId: "dz_mirpur" },
        { id: "zone_uttara", deliveryZoneId: null },
        { id: "area_pallabi", deliveryZoneId: "dz_pallabi" },
    ];
    const resolve = (destination: Parameters<typeof resolveDestinationZoneId>[0]) =>
        resolveDestinationZoneId(destination, { locations, regions });

    it("picks a Bangladesh location before the country: area, then thana, then city", () => {
        expect(resolve({ countryCode: "BD", city: "city_dhaka", zone: "zone_mirpur", area: "area_pallabi" })).toBe("dz_pallabi");
        expect(resolve({ countryCode: "BD", city: "city_dhaka", zone: "zone_mirpur", area: "area_x" })).toBe("dz_mirpur");
        expect(resolve({ countryCode: "BD", city: "city_dhaka", zone: "zone_uttara" })).toBe("dz_dhaka");
        // No country means Bangladesh, as before markets.
        expect(resolve({ city: "city_dhaka", zone: "zone_uttara" })).toBe("dz_dhaka");
    });

    it("gives a Bangladesh address outside every location zone the whole-country zone", () => {
        expect(resolve({ countryCode: "BD", city: "city_ctg", zone: "zone_x" })).toBe("dz_bd");
    });

    it("picks a postal prefix before an admin area, and the longest prefix", () => {
        expect(resolve({ countryCode: "US", adminArea: "CA", postalCode: "94103" })).toBe("dz_sf_core");
        expect(resolve({ countryCode: "US", adminArea: "CA", postalCode: "94199" })).toBe("dz_sf");
        expect(resolve({ countryCode: "US", adminArea: "CA", postalCode: "90210" })).toBe("dz_west");
        expect(resolve({ countryCode: "US", adminArea: "or", postalCode: "97201" })).toBe("dz_west");
        expect(resolve({ countryCode: "US", adminArea: "NY", postalCode: "10001" })).toBe("dz_us");
        expect(resolve({ countryCode: "US" })).toBe("dz_us");
        // Postal codes compare without spaces or case.
        expect(resolve({ countryCode: "GB", postalCode: "sw1a 1aa" })).toBe("dz_london");
    });

    it("matches nothing in a country no zone serves, and never another country's regions", () => {
        expect(resolve({ countryCode: "GB", postalCode: "EC1A 1BB" })).toBeNull();
        expect(resolve({ countryCode: "IN", adminArea: "CA", postalCode: "941000" })).toBeNull();
        // Bangladesh location ids mean nothing outside Bangladesh.
        expect(resolve({ countryCode: "US", city: "city_dhaka", zone: "zone_mirpur" })).toBe("dz_us");
    });

    it("gives a Bangladesh address no zone when no whole-country zone exists", () => {
        expect(resolveDestinationZoneId({ countryCode: "BD", city: "city_ctg", zone: "zone_x" }, { locations, regions: [] })).toBeNull();
    });
});

describe("zoneCountryCoverage: where a zone's rates apply to every address", () => {
    const facts = deliveryCoverageFactsFromText([
        "dz_bd:BD:c",
        "dz_dhaka:BD:l",
        "dz_us:US:c",
        "dz_west:US:p",
        "dz_world:FR:c",
        "dz_world:DE:c",
        "dz_world:DE:p",
    ].join(","));

    it("is entire only when no other zone holds a part of the country", () => {
        expect(zoneCountryCoverage("dz_bd", facts)).toEqual([{ code: "BD", entire: false }]);
        expect(zoneCountryCoverage("dz_dhaka", facts)).toEqual([{ code: "BD", entire: false }]);
        expect(zoneCountryCoverage("dz_us", facts)).toEqual([{ code: "US", entire: false }]);
        expect(zoneCountryCoverage("dz_west", facts)).toEqual([{ code: "US", entire: false }]);
        // Its own region of a country it holds whole changes nothing.
        expect(zoneCountryCoverage("dz_world", facts)).toEqual([{ code: "DE", entire: true }, { code: "FR", entire: true }]);
    });

    it("is entire for a Bangladesh zone when no location zone exists", () => {
        expect(zoneCountryCoverage("dz_bd", deliveryCoverageFactsFromText("dz_bd:BD:c"))).toEqual([{ code: "BD", entire: true }]);
        expect(zoneCountryCoverage("dz_missing", deliveryCoverageFactsFromText("dz_bd:BD:c"))).toEqual([]);
    });

    it("reads no facts from an empty or missing text", () => {
        expect(deliveryCoverageFactsFromText(null)).toEqual({ regions: [], locationZoneIds: new Set() });
        expect(deliveryCoverageFactsFromText("")).toEqual({ regions: [], locationZoneIds: new Set() });
    });
});

describe("normalizePostalPrefix", () => {
    it("keeps letters and digits in upper case", () => {
        expect(normalizePostalPrefix(" sw1a 1aa ")).toBe("SW1A1AA");
        expect(normalizePostalPrefix("K1A-0B1")).toBe("K1A0B1");
        expect(normalizePostalPrefix(null)).toBe("");
    });
});
