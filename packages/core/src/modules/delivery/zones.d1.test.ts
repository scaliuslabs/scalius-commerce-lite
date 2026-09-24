import { describe, expect, it } from "vitest";
import {
    compiledMigrationSql,
    createMigratedSqlite,
    createSqliteD1Database,
} from "@scalius/database/testing/sqlite-d1";
import { validateStorefrontDeliveryPreflight } from "../orders/orders.storefront";
import {
    applyDeliveryZoneTemplate,
    createDeliveryZone,
    deleteDeliveryZone,
    listDeliveryRatesForAddress,
    listDeliveryZones,
    resolveDeliveryRate,
    updateDeliveryZone,
    updateEverywhereElseRates,
} from "./zones";

const BDT = 2;

/** Dhaka (Mirpur → Pallabi, Savar) and Chattogram (Agrabad). */
function seedLocations() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
        INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active) VALUES
            ('dhaka', 'Dhaka', 'city', NULL, '{}', '{}', 1),
            ('mirpur', 'Mirpur', 'zone', 'dhaka', '{}', '{}', 1),
            ('pallabi', 'Pallabi', 'area', 'mirpur', '{}', '{}', 1),
            ('savar', 'Savar', 'zone', 'dhaka', '{}', '{}', 1),
            ('ctg', 'Chattogram', 'city', NULL, '{}', '{}', 1),
            ('agrabad', 'Agrabad', 'zone', 'ctg', '{}', '{}', 1);
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
    const view = await listDeliveryZones(db, BDT);
    const all = [...view.zones.flatMap((zone) => zone.rates), ...view.everywhereElse.rates];
    return all.find((candidate) => candidate.name === name)!.id;
}

const cart = (subtotalMinor: number) => ({ hasFreeDeliveryProduct: false, subtotalMinor });

describe("delivery zone resolution", () => {
    it("picks the most specific zone: area, then zone, then city, then everywhere else", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Dhaka city", locationIds: ["dhaka"], rates: [rate("City rate", 60)] }, BDT);
        await createDeliveryZone(db, { name: "Mirpur", locationIds: ["mirpur"], rates: [rate("Zone rate", 70)] }, BDT);
        await createDeliveryZone(db, { name: "Pallabi", locationIds: ["pallabi"], rates: [rate("Area rate", 80)] }, BDT);
        await updateEverywhereElseRates(db, [rate("Outside rate", 120)], 0, BDT);

        const names = async (address: { city: string; zone?: string; area?: string }) =>
            (await listDeliveryRatesForAddress(db, address)).map((row) => row.name);
        expect(await names({ city: "dhaka", zone: "mirpur", area: "pallabi" })).toEqual(["Area rate"]);
        expect(await names({ city: "dhaka", zone: "mirpur" })).toEqual(["Zone rate"]);
        expect(await names({ city: "dhaka", zone: "savar" })).toEqual(["City rate"]);
        expect(await names({ city: "ctg", zone: "agrabad" })).toEqual(["Outside rate"]);

        const preflight = (address: { city: string; zone: string; area?: string }, shippingMethodId: string) =>
            validateStorefrontDeliveryPreflight(db, { ...address, shippingMethodId }, cart(50_000));
        await expect(preflight({ city: "dhaka", zone: "mirpur", area: "pallabi" }, await rateIdByName(db, "Area rate")))
            .resolves.toMatchObject({ shippingMinor: 8_000, areaName: "Pallabi" });
        await expect(preflight({ city: "ctg", zone: "agrabad" }, await rateIdByName(db, "Outside rate")))
            .resolves.toMatchObject({ shippingMinor: 12_000 });
    });

    it("rejects a rate from another zone at checkout, whatever fee the client shows", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await updateEverywhereElseRates(db, [rate("Outside Dhaka", 120)], 0, BDT);

        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "ctg",
            zone: "agrabad",
            shippingMethodId: await rateIdByName(db, "Inside Dhaka"),
        }, cart(10_000))).rejects.toThrow("isn't available for the selected address");
        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "dhaka",
            zone: "mirpur",
            shippingMethodId: await rateIdByName(db, "Outside Dhaka"),
        }, cart(10_000))).rejects.toThrow("isn't available for the selected address");
    });

    it("makes delivery free from the threshold itself, not one paisa below", async () => {
        const { db } = seedLocations();
        await updateEverywhereElseRates(db, [rate("Standard", 60, { freeOver: 1_000 })], 0, BDT);
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
        await updateEverywhereElseRates(db, [rate("Standard", 60), rate("Express", 150, { isActive: false })], 0, BDT);
        expect((await listDeliveryRatesForAddress(db, { city: "ctg" })).map((row) => row.name)).toEqual(["Standard"]);
        expect((await listDeliveryRatesForAddress(db, null)).map((row) => row.name)).toEqual(["Standard"]);
        await expect(validateStorefrontDeliveryPreflight(db, {
            city: "ctg",
            zone: "agrabad",
            shippingMethodId: await rateIdByName(db, "Express"),
        }, cart(10_000))).rejects.toThrow("A valid active shipping method is required");
    });

    it("returns no rates for an address outside every zone when there are no Everywhere else rates", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        expect(await listDeliveryRatesForAddress(db, { city: "ctg", zone: "agrabad" })).toEqual([]);
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

    it("is offered for every address, inside and outside the zones", async () => {
        const { db } = seedLocations();
        await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await updateEverywhereElseRates(db, [rate("Outside Dhaka", 120), pickup], 0, BDT);

        const names = async (address: { city: string; zone?: string }) =>
            (await listDeliveryRatesForAddress(db, address)).map((row) => row.name);
        expect(await names({ city: "dhaka", zone: "mirpur" })).toEqual(["Inside Dhaka", "Pick up at our shop"]);
        expect(await names({ city: "ctg", zone: "agrabad" })).toEqual(["Outside Dhaka", "Pick up at our shop"]);
        expect((await listDeliveryRatesForAddress(db, { city: "ctg" })).find((row) => row.kind === "pickup"))
            .toMatchObject({ pickupAddress: pickup.pickupAddress, pickupHours: pickup.pickupHours });
    });

    it("resolves whatever zone the address is in, or none", () => {
        const row = { id: "pickup", zoneId: null, name: "Pickup", description: null, feeMinor: 0, freeOverMinor: null, isActive: true, kind: "pickup" as const };
        expect(resolveDeliveryRate({ rate: row, addressZoneId: "dz_inside", subtotalMinor: 0 })).toMatchObject({ kind: "pickup", feeMinor: 0 });
        expect(resolveDeliveryRate({ rate: row, addressZoneId: null, subtotalMinor: 0 })).toMatchObject({ kind: "pickup" });
    });

    it("needs a pickup address and lives outside the zones", async () => {
        const { db } = seedLocations();
        await expect(updateEverywhereElseRates(db, [{ ...pickup, pickupAddress: "  " }], 0, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "pickupAddress"] }] } });
        await expect(createDeliveryZone(db, { name: "Dhaka", locationIds: ["dhaka"], rates: [pickup] }, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "kind"] }] } });
    });
});

describe("delivery zone editing", () => {
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
            .rejects.toMatchObject({ status: 409, code: "SETTINGS_REVISION_CONFLICT" });
        const [zone] = (await listDeliveryZones(db, BDT)).zones;
        expect(zone).toMatchObject({ name: "Dhaka", revision: 2, rates: [{ name: "Inside Dhaka", fee: 70 }] });
    });

    it("rejects the second of two same-second Everywhere else saves from the same revision", async () => {
        const { db } = seedLocations();
        await updateEverywhereElseRates(db, [rate("Standard", 60)], 0, BDT);
        const { revision } = (await listDeliveryZones(db, BDT)).everywhereElse;
        await updateEverywhereElseRates(db, [rate("Standard", 80)], revision, BDT);
        await expect(updateEverywhereElseRates(db, [rate("Standard", 90)], revision, BDT))
            .rejects.toMatchObject({ status: 409, code: "SETTINGS_REVISION_CONFLICT" });
        expect((await listDeliveryZones(db, BDT)).everywhereElse.rates).toMatchObject([{ name: "Standard", fee: 80 }]);
    });

    it("keeps rate ids across edits, soft-deletes removed rates and lets two rates swap names", async () => {
        const { db, sqlite } = seedLocations();
        await updateEverywhereElseRates(db, [rate("Regular", 60), rate("Express", 120)], 0, BDT);
        const before = await listDeliveryZones(db, BDT);
        const [regular, express] = before.everywhereElse.rates;
        await updateEverywhereElseRates(db, [
            { ...express!, name: "Regular" },
            { ...regular!, name: "Express" },
        ], before.everywhereElse.revision, BDT);
        const after = await listDeliveryZones(db, BDT);
        expect(after.everywhereElse.rates.map(({ id, name }) => ({ id, name }))).toEqual([
            { id: express!.id, name: "Regular" },
            { id: regular!.id, name: "Express" },
        ]);

        await updateEverywhereElseRates(db, [after.everywhereElse.rates[0]!], after.everywhereElse.revision, BDT);
        expect(sqlite.prepare("SELECT id, deleted_at IS NOT NULL AS deleted FROM shipping_methods ORDER BY id").all())
            .toEqual(expect.arrayContaining([{ id: regular!.id, deleted: 1 }, { id: express!.id, deleted: 0 }]));
    });

    it("answers out-of-range money with a field issue instead of a server error", async () => {
        const { db } = seedLocations();
        await expect(updateEverywhereElseRates(db, [rate("Huge", 99_999_999_999)], 0, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "fee"] }] } });
        await expect(updateEverywhereElseRates(db, [rate("Fraction", 60.555)], 0, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "fee"] }] } });
        await expect(updateEverywhereElseRates(db, [rate("Free over", 60, { freeOver: 200_000 })], 0, BDT))
            .rejects.toMatchObject({ status: 400, details: { issues: [{ path: ["rates", 0, "freeOver"] }] } });
    });

    it("never removes the last active rate a working checkout depends on", async () => {
        const { db } = seedLocations();
        const { id } = await createDeliveryZone(db, { name: "Inside Dhaka", locationIds: ["dhaka"], rates: [rate("Inside Dhaka", 60)] }, BDT);
        await expect(deleteDeliveryZone(db, id)).rejects.toThrow("Keep at least one active delivery rate");
        await updateEverywhereElseRates(db, [rate("Outside Dhaka", 120)], 0, BDT);
        await deleteDeliveryZone(db, id);
        expect(await listDeliveryRatesForAddress(db, { city: "dhaka", zone: "mirpur" }))
            .toMatchObject([{ name: "Outside Dhaka" }]);
    });

    it("starts three Dhaka-centric zones from the store's own locations", async () => {
        const { db } = seedLocations();
        await updateEverywhereElseRates(db, [rate("Old flat charge", 50)], 0, BDT);
        const { revision } = (await listDeliveryZones(db, BDT)).everywhereElse;
        await applyDeliveryZoneTemplate(db, "dhaka_three_zone", revision, BDT);

        const view = await listDeliveryZones(db, BDT);
        expect(view.zones.map((zone) => ({ name: zone.name, locations: zone.locations.map((l) => l.id), fee: zone.rates[0]!.fee })))
            .toEqual([
                { name: "Inside Dhaka", locations: ["dhaka"], fee: 70 },
                { name: "Near Dhaka", locations: ["savar"], fee: 90 },
            ]);
        expect(view.everywhereElse.rates.map((row) => [row.name, row.fee])).toEqual([["Outside Dhaka", 120]]);
        expect((await listDeliveryRatesForAddress(db, { city: "dhaka", zone: "savar" })).map((row) => row.name))
            .toEqual(["Near Dhaka"]);
        await expect(applyDeliveryZoneTemplate(db, "dhaka_two_zone", view.everywhereElse.revision, BDT))
            .rejects.toMatchObject({ status: 409 });
    });
});

describe("0072 delivery zones migration", () => {
    it.each(["d1", "turso"] as const)("keeps existing flat charges as Everywhere else rates (%s)", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0072_" });
        sqlite.exec(`
            INSERT INTO shipping_methods (id, name, fee_minor, is_active) VALUES ('inside', 'Inside Dhaka', 6000, 1);
            INSERT INTO shipping_methods (id, name, fee_minor, is_active, deleted_at) VALUES ('old', 'Old', 100, 1, unixepoch());
        `);
        sqlite.exec(compiledMigrationSql(provider, undefined, "0072_"));

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
