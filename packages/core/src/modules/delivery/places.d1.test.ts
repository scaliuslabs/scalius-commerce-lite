import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { countPlaceDescendants, deletePlaces } from "./places";
import { createDeliveryZone, listDeliveryRatesForDestination, listDeliveryZones } from "./zones";

/** Nagar (Para → Pallabi, Kazipara; Savar → Hemayetpur) and Chattogram (Agrabad). */
function seed() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
        INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
            ('nagar', 'Nagar', 'BD', 1, NULL, '{}', '{}', 1),
            ('para', 'Para', 'BD', 2, 'nagar', '{}', '{}', 1),
            ('pallabi', 'Pallabi', 'BD', 3, 'para', '{}', '{}', 1),
            ('kazipara', 'Kazipara', 'BD', 3, 'para', '{}', '{}', 1),
            ('savar', 'Savar', 'BD', 2, 'nagar', '{}', '{}', 1),
            ('hemayetpur', 'Hemayetpur', 'BD', 3, 'savar', '{}', '{}', 1),
            ('ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1),
            ('agrabad', 'Agrabad', 'BD', 2, 'ctg', '{}', '{}', 1);
    `);
    return harness;
}

const live = (harness: ReturnType<typeof seed>) =>
    (harness.sqlite.prepare("SELECT id FROM places WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: string }>)
        .map((row) => row.id);

const rate = { name: "Standard", fee: 60, isActive: true };

describe("deleting places", () => {
    it("counts the thanas and areas under each place", async () => {
        const { db } = seed();
        const counts = await countPlaceDescendants(db, ["nagar", "para", "ctg", "pallabi"]);
        expect(counts.get("nagar")).toEqual({ "2": 2, "3": 3 });
        expect(counts.get("para")).toEqual({ "3": 2 });
        expect(counts.get("ctg")).toEqual({ "2": 1 });
        expect(counts.get("pallabi")).toBeUndefined();
    }, 20_000); // The first test also builds the migrated SQLite database.

    it("deletes a city with its thanas and areas and takes them out of delivery zones", async () => {
        const harness = seed();
        const { db } = harness;
        await createDeliveryZone(db, { name: "Para zone", locationIds: ["para", "hemayetpur"], rates: [rate] }, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 });
        await createDeliveryZone(db, { name: "Port", locationIds: ["agrabad"], rates: [{ ...rate, name: "Port" }] }, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 });

        await deletePlaces(db, ["nagar"]);

        expect(live(harness)).toEqual(["agrabad", "ctg"]);
        const zones = (await listDeliveryZones(db, 2)).zones;
        expect(zones.map((zone) => [zone.name, zone.locations.map((place) => place.id)])).toEqual([
            ["Para zone", []],
            ["Port", ["agrabad"]],
        ]);
        const memberships = harness.sqlite.prepare("SELECT location_id FROM delivery_zone_locations ORDER BY location_id").all();
        expect(memberships).toEqual([{ location_id: "agrabad" }]);
        // Once a deleted place is out of its zone, a stale address gets no delivery rate.
        expect(await listDeliveryRatesForDestination(db, { city: "nagar", zone: "para" })).toEqual([]);
    });

    it("deletes a thana with its areas and leaves the rest of the city", async () => {
        const harness = seed();
        await deletePlaces(harness.db, ["para", "agrabad"]);
        expect(live(harness)).toEqual(["ctg", "hemayetpur", "nagar", "savar"]);
        expect(await countPlaceDescendants(harness.db, ["nagar"])).toEqual(new Map([["nagar", { "2": 1, "3": 1 }]]));
    });

    it("stays under D1's bound-parameter limit however many places are deleted at once", async () => {
        const harness = seed();
        const many = [...Array.from({ length: 200 }, (_, index) => `missing-${index}`), "nagar", "ctg"];
        expect((await countPlaceDescendants(harness.db, many)).get("nagar")).toEqual({ "2": 2, "3": 3 });
        await deletePlaces(harness.db, many);
        expect(live(harness)).toEqual([]);
    });
});
