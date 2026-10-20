import { describe, expect, it } from "vitest";
import {
    compiledMigrationSql,
    createMigratedSqlite,
    createSqliteD1Database,
} from "@scalius/database/testing/sqlite-d1";
import { validateStorefrontDeliveryPreflight } from "../checkout/prepare";
import {
    applyDeliveryZoneTemplate,
    createDeliveryZone,
    deleteDeliveryZone,
    listDeliveryRatesForDestination,
    listDeliveryZones,
    resolveDeliveryRate,
    updateDeliveryZone,
    updateDeliveryZoneRate,
    updatePickupRates,
} from "./zones";

const BDT = { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 };
const BANGLADESH = [{ countryCode: "BD" }];

/** Dhaka (Mirpur → Pallabi, Savar) and Chattogram (Agrabad). */
function seedLocations() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
        INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
            ('dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
            ('mirpur', 'Mirpur', 'BD', 2, 'dhaka', '{}', '{}', 1),
            ('pallabi', 'Pallabi', 'BD', 3, 'mirpur', '{}', '{}', 1),
            ('savar', 'Savar', 'BD', 2, 'dhaka', '{}', '{}', 1),
            ('ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1),
            ('agrabad', 'Agrabad', 'BD', 2, 'ctg', '{}', '{}', 1);
    `);
    return harness;
}

const rate = (name: string, fee: number, extra: { freeOver?: number | null; isActive?: boolean } = {}) => ({
    name,
    fee,
    freeOver: extra.freeOver ?? null,
    isActive: extra.isActive ?? true,
});

async function rateIdByName(db: ReturnType<typeof seedLocations>["db"], name: string): Promise<string> {
    const view = await listDeliveryZones(db, BDT.decimalPlaces);
    const all = [...view.zones.flatMap((zone) => zone.rates), ...view.pickup.rates];
    return all.find((candidate) => candidate.name === name)!.id;
}

// One physical line: the cart needs a delivery method.
const cart = (subtotalMinor: number) => ({
    hasFreeDeliveryProduct: false,
    subtotalMinor,
    items: [{ fulfillmentKind: "physical" as const, isGiftCard: false }],
});

const names = async (db: ReturnType<typeof seedLocations>["db"], destination: Parameters<typeof listDeliveryRatesForDestination>[1]) =>
    (await listDeliveryRatesForDestination(db, destination)).map((row) => row.name);

describe("shipping zone resolution in Bangladesh", () => {
    it("picks the most specific zone: area, then thana, then city, then the whole country", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Dhaka city", locationIds: ["dhaka"], rates: [rate("City rate", 60)] }, BDT);
        await createDeliveryZone(db, { name: "Mirpur", locationIds: ["mirpur"], rates: [rate("Zone rate", 70)] }, BDT);
        await createDeliveryZone(db, { name: "Pallabi", locationIds: ["pallabi"], rates: [rate("Area rate", 80)] }, BDT);
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Outside rate", 120)] }, BDT);

        expect(await names(db, { city: "dhaka", zone: "mirpur", area: "pallabi" })).toEqual(["Area rate"]);
        expect(await names(db, { city: "dhaka", zone: "mirpur" })).toEqual(["Zone rate"]);
        expect(await names(db, { countryCode: "BD", city: "dhaka", zone: "savar" })).toEqual(["City rate"]);
        expect(await names(db, { city: "ctg", zone: "agrabad" })).toEqual(["Outside rate"]);

        const preflight = (address: { city: string; zone: string; area?: string }, shippingMethodId: string) =>
            validateStorefrontDeliveryPreflight(db, { ...address, shippingMethodId }, cart(50_000));
        await expect(preflight({ city: "dhaka", zone: "mirpur", area: "pallabi" }, await rateIdByName(db, "Area rate")))
            .resolves.toMatchObject({ shippingMinor: 8_000, areaName: "Pallabi", address: { countryCode: "BD", city: "dhaka" } });
        await expect(preflight({ city: "ctg", zone: "agrabad" }, await rateIdByName(db, "Outside rate")))
            .resolves.toMatchObject({ shippingMinor: 12_000 });
    });

    it("rejects a rate from another zone at checkout, whatever fee the client shows", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Outside Dhaka", 120)] }, BDT);

        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "ctg",
            zone: "agrabad",
            shippingMethodId: await rateIdByName(db, "Inside Dhaka"),
        }, cart(10_000))).rejects.toThrow("isn't available for the selected address");
        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "dhaka",
            zone: "mirpur",
            shippingMethodId: await rateIdByName(db, "Outside Dhaka"),
        }, cart(10_000))).rejects.toMatchObject({
            message: expect.stringContaining("isn't available for the selected address"),
            // Checkout re-reads the address's rates on this reason instead of reporting a failure.
            details: { reason: "delivery_rate_unavailable" },
        });
    });

    it("makes delivery free from the threshold itself, not one paisa below", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Standard", 60, { freeOver: 1_000 })] }, BDT);
        const id = await rateIdByName(db, "Standard");
        const quote = (subtotalMinor: number) =>
            validateStorefrontDeliveryPreflight(db, { city: "ctg", zone: "agrabad", shippingMethodId: id }, cart(subtotalMinor));

        await expect(quote(99_999)).resolves.toMatchObject({
            shippingMinor: 6_000,
            shippingMethod: { baseAmountMinor: 6_000, feeWaived: false },
        });
        await expect(quote(100_000)).resolves.toMatchObject({
            shippingMinor: 0,
            shippingMethod: { baseAmountMinor: 6_000, feeWaived: true },
        });
    });

    it("hides inactive rates from buyers and refuses them at checkout", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, {
            name: "Bangladesh",
            regions: BANGLADESH,
            rates: [rate("Standard", 60), rate("Express", 150, { isActive: false })],
        }, BDT);
        expect(await names(db, { city: "ctg" })).toEqual(["Standard"]);
        expect(await names(db, null)).toEqual(["Standard"]);
        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "ctg",
            zone: "agrabad",
            shippingMethodId: await rateIdByName(db, "Express"),
        }, cart(10_000))).rejects.toThrow("A valid active shipping method is required");
    });

    it("offers no delivery rate for an address no zone serves, and says so at checkout (fail closed)", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        expect(await listDeliveryRatesForDestination(db, { city: "ctg", zone: "agrabad" })).toEqual([]);
        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "ctg",
            zone: "agrabad",
            shippingMethodId: await rateIdByName(db, "Inside Dhaka"),
        }, cart(10_000))).rejects.toMatchObject({
            message: expect.stringContaining("We don't deliver to this address"),
            details: { reason: "delivery_rate_unavailable" },
        });
    });
});

describe("shipping zones outside Bangladesh", () => {
    const US = { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 };

    async function seedWorld() {
        const harness = seedLocations();
        const { db } = harness;
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Bangladesh", 120)] }, BDT);
        await createDeliveryZone(db, { name: "United States", regions: [{ countryCode: "US" }], rates: [rate("US standard", 25)] }, US);
        await createDeliveryZone(db, {
            name: "West coast",
            regions: [{ countryCode: "US", adminArea: "California" }, { countryCode: "US", adminArea: "or" }],
            rates: [rate("West coast", 15)],
        }, US);
        await createDeliveryZone(db, { name: "San Francisco", regions: [{ countryCode: "US", postalPrefix: "941 " }], rates: [rate("SF courier", 9)] }, US);
        await createDeliveryZone(db, { name: "London", regions: [{ countryCode: "GB", postalPrefix: "sw1" }], rates: [rate("London", 12)] }, US);
        return harness;
    }

    it("gets a foreign address the rates of its most specific zone: postal prefix > admin area > country", async () => {
        const { db } = await seedWorld();
        expect(await names(db, { countryCode: "US", adminArea: "CA", postalCode: "94103" })).toEqual(["SF courier"]);
        expect(await names(db, { countryCode: "US", adminArea: "California", postalCode: "90210" })).toEqual(["West coast"]);
        expect(await names(db, { countryCode: "US", adminArea: "OR" })).toEqual(["West coast"]);
        expect(await names(db, { countryCode: "US", adminArea: "NY", postalCode: "10001" })).toEqual(["US standard"]);
        expect(await names(db, { countryCode: "GB", postalCode: "SW1A 1AA" })).toEqual(["London"]);
        // No zone: no delivery rate (pickup would still be listed).
        expect(await names(db, { countryCode: "GB", postalCode: "EC1A 1BB" })).toEqual([]);
        expect(await names(db, { countryCode: "IN" })).toEqual([]);
    });

    it("prices a foreign delivery at checkout with the zone's rate and refuses another zone's", async () => {
        const { db } = await seedWorld();
        const ok = await validateStorefrontDeliveryPreflight(db, {
            shippingCountryCode: "US",
            shippingAdminArea: "California",
            shippingPostalCode: "94103",
            shippingMethodId: await rateIdByName(db, "SF courier"),
        }, cart(10_000));
        expect(ok).toMatchObject({
            kind: "delivery",
            shippingMinor: 900,
            cityName: null,
            address: { countryCode: "US", city: null, zone: null, adminArea: "CA", postalCode: "94103" },
        });
        await expect(validateStorefrontDeliveryPreflight(db, {
            shippingCountryCode: "US",
            shippingAdminArea: "CA",
            shippingPostalCode: "94103",
            shippingMethodId: await rateIdByName(db, "US standard"),
        }, cart(10_000))).rejects.toMatchObject({ details: { reason: "delivery_rate_unavailable" } });
        await expect(validateStorefrontDeliveryPreflight(db, {
            shippingCountryCode: "IN",
            shippingMethodId: await rateIdByName(db, "US standard"),
        }, cart(10_000))).rejects.toThrow("We don't deliver to this address");
    });

    it("says which countries each rate serves, and where it serves every address", async () => {
        const { db } = await seedWorld();
        await createDeliveryZone(db, { name: "Europe", regions: [{ countryCode: "FR" }, { countryCode: "DE" }], rates: [rate("Europe", 30)] }, US);
        const rates = await listDeliveryRatesForDestination(db, null);
        const countries = Object.fromEntries(rates.map((row) => [row.name, row.countries]));
        expect(countries).toEqual({
            "Bangladesh": [{ code: "BD", entire: true }],
            "US standard": [{ code: "US", entire: false }],
            "West coast": [{ code: "US", entire: false }],
            "SF courier": [{ code: "US", entire: false }],
            "London": [{ code: "GB", entire: false }],
            "Europe": [{ code: "DE", entire: true }, { code: "FR", entire: true }],
        });
    });

    it("keeps a region in one zone and checks each region against the country's rules", async () => {
        const { db } = await seedWorld();
        const zone = (regions: Array<{ countryCode: string; adminArea?: string; postalPrefix?: string }>) =>
            createDeliveryZone(db, { name: "Again", regions, rates: [] }, US);
        await expect(zone([{ countryCode: "US" }])).rejects.toMatchObject({ status: 400, message: expect.stringContaining("already in United States") });
        await expect(zone([{ countryCode: "US", adminArea: "CA" }])).rejects.toMatchObject({ message: expect.stringContaining("already in West coast") });
        await expect(zone([{ countryCode: "US", postalPrefix: "941" }])).rejects.toMatchObject({ message: expect.stringContaining("already in San Francisco") });
        await expect(zone([{ countryCode: "XX" }])).rejects.toMatchObject({ details: { issues: [{ path: ["regions", 0, "countryCode"] }] } });
        await expect(zone([{ countryCode: "US", adminArea: "Atlantis" }])).rejects.toMatchObject({ details: { issues: [{ path: ["regions", 0, "adminArea"] }] } });
        await expect(zone([{ countryCode: "US", postalPrefix: "94-103-0000-12" }])).rejects.toMatchObject({ details: { issues: [{ path: ["regions", 0, "postalPrefix"] }] } });
        await expect(zone([{ countryCode: "BD", postalPrefix: "1216" }])).rejects.toMatchObject({ status: 400 });
        await expect(zone([])).rejects.toMatchObject({ details: { issues: [{ path: ["regions"] }] } });
        await expect(createDeliveryZone(db, { name: "Mixed", regions: BANGLADESH, locationIds: ["ctg"], rates: [] }, BDT))
            .rejects.toMatchObject({ details: { issues: [{ path: ["locationIds"] }] } });
        // An edit keeps its own regions.
        const view = await listDeliveryZones(db, 2);
        const west = view.zones.find((entry) => entry.name === "West coast")!;
        expect(west.regions).toEqual([
            { countryCode: "US", adminArea: "CA", postalPrefix: null },
            { countryCode: "US", adminArea: "OR", postalPrefix: null },
        ]);
        await expect(updateDeliveryZone(db, west.id, {
            name: "West",
            regions: [...west.regions.map(({ countryCode, adminArea }) => ({ countryCode, adminArea })), { countryCode: "US", adminArea: "WA" }],
            rates: west.rates,
        }, west.revision, US)).resolves.toMatchObject({ revision: 2 });
    });

    it("drops a deleted zone's regions with it", async () => {
        const { db, sqlite } = await seedWorld();
        const london = (await listDeliveryZones(db, 2)).zones.find((zone) => zone.name === "London")!;
        await deleteDeliveryZone(db, london.id);
        expect(sqlite.prepare("SELECT count(*) AS n FROM delivery_zone_regions WHERE country_code = 'GB'").get()).toEqual({ n: 0 });
        expect(await names(db, { countryCode: "GB", postalCode: "SW1A 1AA" })).toEqual([]);
    });
});

describe("local pickup", () => {
    const pickup = {
        name: "Pick up at our shop",
        fee: 0,
        kind: "pickup" as const,
        pickupAddress: "House 12, Road 5, Dhanmondi",
        pickupHours: "10 am – 8 pm",
        isActive: true,
    };

    it("is offered for every address, inside and outside the zones, at home and abroad", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Outside Dhaka", 120)] }, BDT);
        await updatePickupRates(db, [pickup], 0, BDT);

        expect(await names(db, { city: "dhaka", zone: "mirpur" })).toEqual(["Inside Dhaka", "Pick up at our shop"]);
        expect(await names(db, { city: "ctg", zone: "agrabad" })).toEqual(["Outside Dhaka", "Pick up at our shop"]);
        expect(await names(db, { countryCode: "US", postalCode: "94103" })).toEqual(["Pick up at our shop"]);
        expect((await listDeliveryRatesForDestination(db, { city: "ctg" })).find((row) => row.kind === "pickup"))
            .toMatchObject({ pickupAddress: pickup.pickupAddress, pickupHours: pickup.pickupHours, zoneId: null, countries: [] });
    });

    it("resolves whatever zone the address is in, or none", () => {
        const row = { id: "pickup", zoneId: null, name: "Pickup", description: null, feeMinor: 0, freeOverMinor: null, isActive: true, kind: "pickup" as const };
        expect(resolveDeliveryRate({ rate: row, addressZoneId: "dz_inside", subtotalMinor: 0 })).toMatchObject({ kind: "pickup", feeMinor: 0 });
        expect(resolveDeliveryRate({ rate: row, addressZoneId: null, subtotalMinor: 0 })).toMatchObject({ kind: "pickup" });
    });

    it("needs a pickup address and lives outside the zones", async () => {
        const { db } = seedLocations();
        await expect(updatePickupRates(db, [{ ...pickup, pickupAddress: "  " }], 0, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "pickupAddress"] }] } });
        await expect(createDeliveryZone(db, { name: "Dhaka", locationIds: ["dhaka"], rates: [pickup] }, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "kind"] }] } });
    });

    it("rejects the second of two same-second pickup saves from the same revision", async () => {
        const { db } = seedLocations();
        await updatePickupRates(db, [pickup], 0, BDT);
        const { revision } = (await listDeliveryZones(db, BDT.decimalPlaces)).pickup;
        await updatePickupRates(db, [{ ...pickup, fee: 20 }], revision, BDT);
        await expect(updatePickupRates(db, [{ ...pickup, fee: 30 }], revision, BDT))
            .rejects.toMatchObject({ status: 409, code: "settings_revision_conflict" });
        expect((await listDeliveryZones(db, BDT.decimalPlaces)).pickup.rates).toMatchObject([{ name: pickup.name, fee: 20 }]);
    });
});

describe("shipping zone editing", () => {
    it("refuses paisa in a taka delivery charge or free-over threshold", async () => {
        const { db } = seedLocations();
        await expect(createDeliveryZone(db, {
            name: "Inside Dhaka",
            locationIds: ["dhaka"],
            rates: [rate("Inside Dhaka", 60.5, { freeOver: 999.99 })],
        }, BDT)).rejects.toMatchObject({
            status: 400,
            details: { issues: [
                { path: ["rates", 0, "fee"], message: "Taka amounts are whole numbers." },
                { path: ["rates", 0, "freeOver"], message: "Taka amounts are whole numbers." },
            ] },
        });
        await expect(createDeliveryZone(db, {
            name: "Inside Dhaka",
            locationIds: ["dhaka"],
            rates: [rate("Inside Dhaka", 60.5)],
        }, { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 })).resolves.toBeTruthy();
    });

    it("keeps a location in at most one zone", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await expect(createDeliveryZone(db, { name: "Again", locationIds: ["dhaka"], rates: [] }, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["locationIds"] }] } });
    });

    it("rejects a stale zone edit with a 409 and keeps the first save", async () => {
        const { db } = seedLocations();
        const { id } = await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await updateDeliveryZone(db, id, { name: "Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 70)] }, 1, BDT);
        await expect(updateDeliveryZone(db, id, { name: "Stale", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 50)] }, 1, BDT))
            .rejects.toMatchObject({ status: 409, code: "settings_revision_conflict" });
        const [zone] = (await listDeliveryZones(db, BDT.decimalPlaces)).zones;
        expect(zone).toMatchObject({ name: "Dhaka", revision: 2, rates: [{ name: "Inside Dhaka", fee: 70 }] });
    });

    it("keeps rate ids across edits, soft-deletes removed rates and lets two rates swap names", async () => {
        const { db, sqlite } = seedLocations();
        const { id } = await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Regular", 60), rate("Express", 120)] }, BDT);
        const before = (await listDeliveryZones(db, BDT.decimalPlaces)).zones[0]!;
        const [regular, express] = before.rates;
        await updateDeliveryZone(db, id, {
            name: "Bangladesh",
            regions: BANGLADESH,
            rates: [{ ...express!, name: "Regular" }, { ...regular!, name: "Express" }],
        }, before.revision, BDT);
        const after = (await listDeliveryZones(db, BDT.decimalPlaces)).zones[0]!;
        expect(after.rates.map(({ id: rateId, name }) => ({ id: rateId, name }))).toEqual([
            { id: express!.id, name: "Regular" },
            { id: regular!.id, name: "Express" },
        ]);

        await updateDeliveryZone(db, id, { name: "Bangladesh", regions: BANGLADESH, rates: [after.rates[0]!] }, after.revision, BDT);
        expect(sqlite.prepare("SELECT id, deleted_at IS NOT NULL AS deleted FROM shipping_methods ORDER BY id").all())
            .toEqual(expect.arrayContaining([{ id: regular!.id, deleted: 1 }, { id: express!.id, deleted: 0 }]));
    });

    it("answers out-of-range money with a field issue instead of a server error", async () => {
        const { db } = seedLocations();
        const create = (rates: ReturnType<typeof rate>[]) => createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates }, BDT);
        await expect(create([rate("Huge", 99_999_999_999)]))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "fee"] }] } });
        await expect(create([rate("Fraction", 60.555)]))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "fee"] }] } });
        await expect(create([rate("Free over", 60, { freeOver: 200_000 })]))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "freeOver"] }] } });
    });

    it("never removes the last active rate a working checkout depends on", async () => {
        const { db } = seedLocations();
        const { id } = await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await expect(deleteDeliveryZone(db, id)).rejects.toThrow("Keep at least one active delivery rate");
        await createDeliveryZone(db, { name: "Bangladesh", regions: BANGLADESH, rates: [rate("Outside Dhaka", 120)] }, BDT);
        await deleteDeliveryZone(db, id);
        expect(await listDeliveryRatesForDestination(db, { city: "dhaka", zone: "mirpur" }))
            .toMatchObject([{ name: "Outside Dhaka" }]);
    });

    it("starts three Dhaka-centric zones from the store's own locations", async () => {
        const { db } = seedLocations();
        await applyDeliveryZoneTemplate(db, "dhaka_three_zone", BDT);

        const view = await listDeliveryZones(db, BDT.decimalPlaces);
        expect(view.zones.map((zone) => ({
            name: zone.name,
            regions: zone.regions.map((region) => region.countryCode),
            locations: zone.locations.map((l) => l.id),
            rate: [zone.rates[0]!.name, zone.rates[0]!.fee],
        }))).toEqual([
            { name: "Inside Dhaka", regions: [], locations: ["dhaka"], rate: ["Inside Dhaka", 70] },
            { name: "Near Dhaka", regions: [], locations: ["savar"], rate: ["Near Dhaka", 90] },
            { name: "Bangladesh", regions: ["BD"], locations: [], rate: ["Outside Dhaka", 120] },
        ]);
        expect(await names(db, { city: "dhaka", zone: "savar" })).toEqual(["Near Dhaka"]);
        expect(await names(db, { city: "ctg", zone: "agrabad" })).toEqual(["Outside Dhaka"]);
        await expect(applyDeliveryZoneTemplate(db, "dhaka_two_zone", BDT)).rejects.toMatchObject({ status: 409 });
    });

    it("sets one rate's fee and threshold against the zone revision, leaving the rest of the zone alone", async () => {
        const { db } = seedLocations();
        await applyDeliveryZoneTemplate(db, "dhaka_two_zone", BDT);
        const before = await listDeliveryZones(db, BDT.decimalPlaces);
        const inside = before.zones.find((zone) => zone.name === "Inside Dhaka")!;
        const outside = before.zones.find((zone) => zone.name === "Bangladesh")!;
        const rateId = inside.rates[0]!.id;

        await expect(updateDeliveryZoneRate(db, inside.id, rateId, { fee: 65 }, inside.revision, BDT))
            .resolves.toEqual({ id: inside.id, revision: inside.revision + 1 });
        await updateDeliveryZoneRate(db, inside.id, rateId, { freeOver: 3000 }, inside.revision + 1, BDT);

        const after = await listDeliveryZones(db, BDT.decimalPlaces);
        const insideAfter = after.zones.find((zone) => zone.id === inside.id)!;
        expect(insideAfter.rates).toEqual([{ ...inside.rates[0]!, fee: 65, freeOver: 3000 }]);
        expect(insideAfter.locations).toEqual(inside.locations);
        expect(after.zones.find((zone) => zone.id === outside.id)).toEqual(outside);
        expect((await listDeliveryRatesForDestination(db, { city: "dhaka" }))[0]).toMatchObject({ feeMinor: 6_500, freeOverMinor: 300_000 });

        // A stale revision, a rate of another zone, paisa and an empty change are refused.
        await expect(updateDeliveryZoneRate(db, inside.id, rateId, { fee: 70 }, inside.revision, BDT)).rejects.toMatchObject({ status: 409 });
        await expect(updateDeliveryZoneRate(db, inside.id, outside.rates[0]!.id, { fee: 70 }, insideAfter.revision, BDT))
            .rejects.toMatchObject({ status: 404 });
        await expect(updateDeliveryZoneRate(db, inside.id, rateId, { fee: 60.5 }, insideAfter.revision, BDT))
            .rejects.toMatchObject({ status: 400 });
        await expect(updateDeliveryZoneRate(db, inside.id, rateId, {}, insideAfter.revision, BDT)).rejects.toMatchObject({ status: 400 });
        await updateDeliveryZoneRate(db, inside.id, rateId, { freeOver: null }, insideAfter.revision, BDT);
        expect((await listDeliveryZones(db, BDT.decimalPlaces)).zones.find((zone) => zone.id === inside.id)!.rates[0]!.freeOver).toBeNull();
    });
});

describe("D1 cost of zones by region (MARKETS-DESIGN step 3b)", () => {
    it("reads a destination's rates in the statements a Bangladesh address cost before", async () => {
        let statements = 0;
        let batches = 0;
        const harness = createSqliteD1Database({
            onQuery: () => { statements += 1; },
            beforeBatch: () => { batches += 1; },
        });
        harness.sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
                ('dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('mirpur', 'Mirpur', 'BD', 2, 'dhaka', '{}', '{}', 1),
                ('ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1), ('agrabad', 'Agrabad', 'BD', 2, 'ctg', '{}', '{}', 1);
            INSERT INTO delivery_zones (id, name) VALUES ('dz_dhaka', 'Inside Dhaka'), ('dz_bd', 'Bangladesh');
            INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('dhaka', 'dz_dhaka');
            INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
            INSERT INTO shipping_methods (id, name, fee_minor, zone_id) VALUES ('sm_in', 'Inside Dhaka', 6000, 'dz_dhaka'), ('sm_out', 'Outside Dhaka', 12000, 'dz_bd');
        `);
        const cost = async (read: () => Promise<unknown>) => {
            [statements, batches] = [0, 0];
            await read();
            return { statements, batches };
        };
        // One statement for the zone candidates (locations and regions), one for the rates: as before.
        expect(await cost(() => listDeliveryRatesForDestination(harness.db, { city: "ctg", zone: "agrabad" }))).toEqual({ statements: 2, batches: 0 });
        expect(await cost(() => listDeliveryRatesForDestination(harness.db, { countryCode: "US", postalCode: "94103" }))).toEqual({ statements: 2, batches: 0 });
        expect(await cost(() => listDeliveryRatesForDestination(harness.db, null))).toEqual({ statements: 1, batches: 0 });
        // The preflight: one batch of the locations and the rate (which carries its country's regions).
        expect(await cost(() => validateStorefrontDeliveryPreflight(harness.db, { city: "ctg", zone: "agrabad", shippingMethodId: "sm_out" }, cart(10_000))))
            .toEqual({ statements: 2, batches: 1 });
    });
});

describe("0072 delivery zones migration", () => {
    it.each(["d1", "turso"] as const)("keeps existing flat charges as zoneless rates (%s)", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0072_" });
        sqlite.exec(`
            INSERT INTO shipping_methods (id, name, fee_minor, is_active) VALUES ('inside', 'Inside Dhaka', 6000, 1);
            INSERT INTO shipping_methods (id, name, fee_minor, is_active, deleted_at) VALUES ('old', 'Old', 100, 1, unixepoch());
        `);
        sqlite.exec(compiledMigrationSql(provider, "0073_", "0072_"));

        expect(sqlite.prepare("SELECT id, zone_id, free_over_minor FROM shipping_methods ORDER BY id").all()).toEqual([
            { id: "inside", zone_id: null, free_over_minor: null },
            { id: "old", zone_id: null, free_over_minor: null },
        ]);
        // Names are unique per zone among live rates only.
        sqlite.exec("INSERT INTO shipping_methods (id, name, fee_minor) VALUES ('old_again', 'Old', 200)");
        expect(() => sqlite.exec("INSERT INTO shipping_methods (id, name, fee_minor) VALUES ('dupe', ' inside dhaka ', 1)"))
            .toThrow(/UNIQUE/);
        sqlite.close();
    });
});
