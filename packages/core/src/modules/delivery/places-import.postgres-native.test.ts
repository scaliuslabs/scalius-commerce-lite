// PostgreSQL parity for the place import: the reads are json_each lists, the
// write is one insert-select upsert per level (ON CONFLICT on the id) with
// integer casts, and finish is one update. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import type { PlaceDatasetEntry } from "@scalius/shared/places";

import { importPlaces } from "./places-import";
import { getExternalLocationIds } from "./places";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

const places: PlaceDatasetEntry[] = [
    { key: "pathao:city:1", level: 1, parent: null, name: "Dhaka", externalIds: { pathao: "1" }, active: true, legacyId: "leg_dhaka" },
    { key: "pathao:zone:10", level: 2, parent: "pathao:city:1", name: "Mirpur", externalIds: { pathao: "10" }, active: true },
    { key: "pathao:zone:11", level: 2, parent: "pathao:city:1", name: "Gulshan", externalIds: { pathao: "11" }, active: true },
    { key: "pathao:area:100", level: 3, parent: "pathao:zone:10", name: "Section 10", externalIds: { pathao: "100" }, active: false, homeDelivery: true },
];

describe.runIf(postgresUrl)("place import on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("creates, re-runs without changes, adopts courier ids and finishes a version", async () => {
        const { db, client } = await createNativePostgres({ label: "places" });
        await client.query(`INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata, is_active)
            VALUES ('own_gulshan_old', 'BD', 1, NULL, 'Old root', '{"steadfast":"9"}', '{}', 1)`);
        const input = (list: PlaceDatasetEntry[], version: string, finish = false) =>
            ({ country: "BD", source: "bd", version, places: list, finish });

        expect(await importPlaces(db, input(places, "v1"))).toMatchObject({ created: 4, updated: 0, conflictCount: 0 });
        expect(await importPlaces(db, input(places, "v1"))).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
        const rows = (await client.query(`SELECT id, level, parent_id, name, is_active, source, source_key, source_active, metadata
            FROM places WHERE source = 'bd' ORDER BY level, name`)).rows;
        expect(rows.map((row) => [Number(row.level), row.name, Number(row.is_active), row.source_key, Number(row.source_active)])).toEqual([
            [1, "Dhaka", 1, "pathao:city:1", 1],
            [2, "Gulshan", 1, "pathao:zone:11", 1],
            [2, "Mirpur", 1, "pathao:zone:10", 1],
            [3, "Section 10", 0, "pathao:area:100", 0],
        ]);
        expect(rows[0]!.id).toBe("leg_dhaka");
        expect(rows[3]!.metadata).toBe('{"home_delivery_available":true}');
        expect(await getExternalLocationIds(db, { city: "leg_dhaka", zone: rows[2]!.id }, "pathao")).toEqual({ city: 1, zone: 10 });

        const result = await importPlaces(db, input(places.filter((place) => place.name !== "Gulshan"), "v2", true));
        expect(result).toMatchObject({ updated: 3, deactivated: 1 });
        expect((await client.query("SELECT is_active FROM places WHERE source_key = 'pathao:zone:11'")).rows.map((row) => Number(row.is_active))).toEqual([0]);
        expect((await client.query("SELECT is_active FROM places WHERE id = 'own_gulshan_old'")).rows.map((row) => Number(row.is_active))).toEqual([1]);
    });
});
