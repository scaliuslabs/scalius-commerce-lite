import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { countLocationDescendants, deleteLocations } from "./locations";
import { createDeliveryZone, listDeliveryRatesForAddress, listDeliveryZones } from "./zones";

/** Nagar (Para → Pallabi, Kazipara; Savar → Hemayetpur) and Chattogram (Agrabad). */
function seed() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
        INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active) VALUES
            ('nagar', 'Nagar', 'city', NULL, '{}', '{}', 1),
            ('para', 'Para', 'zone', 'nagar', '{}', '{}', 1),
            ('pallabi', 'Pallabi', 'area', 'para', '{}', '{}', 1),
            ('kazipara', 'Kazipara', 'area', 'para', '{}', '{}', 1),
            ('savar', 'Savar', 'zone', 'nagar', '{}', '{}', 1),
            ('hemayetpur', 'Hemayetpur', 'area', 'savar', '{}', '{}', 1),
            ('ctg', 'Chattogram', 'city', NULL, '{}', '{}', 1),
            ('agrabad', 'Agrabad', 'zone', 'ctg', '{}', '{}', 1);
    `);
    return harness;
}

const live = (harness: ReturnType<typeof seed>) =>
    (harness.sqlite.prepare("SELECT id FROM delivery_locations WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: string }>)
        .map((row) => row.id);

const rate = { name: "Standard", fee: 60, isActive: true };

describe("deleting delivery locations", () => {
    it("counts the thanas and areas under each place", async () => {
        const { db } = seed();
        const counts = await countLocationDescendants(db, ["nagar", "para", "ctg", "pallabi"]);
        expect(counts.get("nagar")).toEqual({ zones: 2, areas: 3 });
        expect(counts.get("para")).toEqual({ zones: 0, areas: 2 });
        expect(counts.get("ctg")).toEqual({ zones: 1, areas: 0 });
        expect(counts.get("pallabi")).toBeUndefined();
    }, 20_000); // The first test also builds the migrated SQLite database.

    it("deletes a city with its thanas and areas and takes them out of delivery zones", async () => {
        const harness = seed();
        const { db } = harness;
        await createDeliveryZone(db, { name: "Para zone", locationIds: ["para", "hemayetpur"], rates: [rate] }, { code: "BDT", decimalPlaces: 2 });
        await createDeliveryZone(db, { name: "Port", locationIds: ["agrabad"], rates: [{ ...rate, name: "Port" }] }, { code: "BDT", decimalPlaces: 2 });

        await deleteLocations(db, ["nagar"]);

        expect(live(harness)).toEqual(["agrabad", "ctg"]);
        const zones = (await listDeliveryZones(db, 2)).zones;
        expect(zones.map((zone) => [zone.name, zone.locations.map((place) => place.id)])).toEqual([
            ["Para zone", []],
            ["Port", ["agrabad"]],
        ]);
        const memberships = harness.sqlite.prepare("SELECT location_id FROM delivery_zone_locations ORDER BY location_id").all();
        expect(memberships).toEqual([{ location_id: "agrabad" }]);
        // Once a deleted place is out of its zone, a stale address falls back to everywhere else.
        expect(await listDeliveryRatesForAddress(db, { city: "nagar", zone: "para" })).toEqual([]);
    });

    it("deletes a thana with its areas and leaves the rest of the city", async () => {
        const harness = seed();
        await deleteLocations(harness.db, ["para", "agrabad"]);
        expect(live(harness)).toEqual(["ctg", "hemayetpur", "nagar", "savar"]);
        expect(await countLocationDescendants(harness.db, ["nagar"])).toEqual(new Map([["nagar", { zones: 1, areas: 1 }]]));
    });

    it("stays under D1's bound-parameter limit however many places are deleted at once", async () => {
        const harness = seed();
        const many = [...Array.from({ length: 200 }, (_, index) => `missing-${index}`), "nagar", "ctg"];
        expect((await countLocationDescendants(harness.db, many)).get("nagar")).toEqual({ zones: 2, areas: 3 });
        await deleteLocations(harness.db, many);
        expect(live(harness)).toEqual([]);
    });
});
