import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { PlaceDatasetEntry } from "@scalius/shared/places";

import { importPlaces, type PlaceImportInput } from "./places-import";

const city = (id: number, name: string, extra: Partial<PlaceDatasetEntry> = {}): PlaceDatasetEntry =>
    ({ key: `pathao:city:${id}`, level: 1, parent: null, name, externalIds: { pathao: String(id) }, active: true, ...extra });
const zone = (id: number, parent: number, name: string, extra: Partial<PlaceDatasetEntry> = {}): PlaceDatasetEntry =>
    ({ key: `pathao:zone:${id}`, level: 2, parent: `pathao:city:${parent}`, name, externalIds: { pathao: String(id) }, active: true, ...extra });
const area = (id: number, parent: number, name: string, extra: Partial<PlaceDatasetEntry> = {}): PlaceDatasetEntry =>
    ({ key: `pathao:area:${id}`, level: 3, parent: `pathao:zone:${parent}`, name, externalIds: { pathao: String(id) }, active: true, ...extra });

const DATASET = [
    city(1, "Dhaka", { legacyId: "leg_dhaka" }),
    city(2, "Chattogram", { legacyId: "leg_ctg" }),
    zone(10, 1, "Mirpur", { legacyId: "leg_mirpur" }),
    zone(11, 1, "Gulshan"),
    zone(20, 2, "Agrabad"),
    area(100, 10, "Section 10", { homeDelivery: true, pickup: false, legacyId: "leg_s10" }),
    area(101, 10, "Section 11", { active: false }),
];

function harness() {
    const queries: Array<{ query: string; values: number }> = [];
    const test = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values: values.length }) });
    const rows = () => test.sqlite.prepare(`SELECT id, country_code AS country, level, parent_id AS parent, name, external_ids AS ids,
        metadata, is_active AS active, source, source_key AS key, source_version AS version, source_active AS sourceActive,
        deleted_at IS NOT NULL AS deleted FROM places ORDER BY level, name`).all() as Array<Record<string, unknown>>;
    const byName = (name: string) => rows().find((row) => row.name === name)!;
    const seq = (dep: string) => (test.sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(dep) as { seq: number } | undefined)?.seq ?? 0;
    const fence = () => (test.sqlite.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    return { ...test, queries, rows, byName, seq, fence };
}

const input = (places: PlaceDatasetEntry[], extra: Partial<PlaceImportInput> = {}): PlaceImportInput =>
    ({ country: "BD", source: "bd", version: "v1", places, ...extra });

describe("importing a place dataset", () => {
    it("creates the dataset's places, parents before children, across calls, under their legacy ids", async () => {
        const { db, rows, byName } = harness();
        expect(await importPlaces(db, input(DATASET.slice(0, 3)))).toMatchObject({ created: 3, updated: 0, conflictCount: 0 });
        expect(await importPlaces(db, input(DATASET.slice(3)))).toMatchObject({ created: 4, updated: 0, conflictCount: 0 });
        expect(rows()).toHaveLength(7);
        expect(byName("Dhaka")).toMatchObject({ id: "leg_dhaka", country: "BD", level: 1, parent: null, source: "bd", key: "pathao:city:1", version: "v1", active: 1, sourceActive: 1 });
        expect(byName("Mirpur")).toMatchObject({ id: "leg_mirpur", parent: "leg_dhaka", level: 2 });
        expect(byName("Section 10")).toMatchObject({ id: "leg_s10", parent: "leg_mirpur", ids: '{"pathao":"100"}', metadata: '{"home_delivery_available":true,"pickup_available":false}' });
        expect(byName("Section 11")).toMatchObject({ active: 0, sourceActive: 0 });
        expect(byName("Gulshan").id).toMatch(/^[a-z0-9]{20,}$/);
    }); // The first test also builds the migrated SQLite database.

    it("changes nothing when the same version runs again", async () => {
        const { db, seq, fence, queries } = harness();
        await importPlaces(db, input(DATASET));
        const [loc, revision] = [seq("loc"), fence()];
        queries.length = 0;
        expect(await importPlaces(db, input(DATASET))).toMatchObject({ created: 0, updated: 0, unchanged: 7 });
        expect([seq("loc"), fence()]).toEqual([loc, revision]);
        // Reads only: three levels, each one round of at most four statements.
        expect(queries.every((query) => /^select/i.test(query.query))).toBe(true);
        expect(queries.length).toBeLessThanOrEqual(12);
        // A new version only stamps the places: buyers see no change.
        expect(await importPlaces(db, input(DATASET, { version: "v2" }))).toMatchObject({ updated: 7 });
        expect([seq("loc"), fence()]).toEqual([loc, revision]);
    });

    it("adopts the rows a store already has: by legacy id, by courier id, then by name", async () => {
        const { db, sqlite, rows, byName } = harness();
        sqlite.exec(`INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata, is_active) VALUES
            ('leg_dhaka', 'BD', 1, NULL, 'Dhaka City', '{"pathao":"1","steadfast":"D"}', '{}', 1),
            ('own_ctg', 'BD', 1, NULL, 'Old Chattogram', '{"pathao":"2"}', '{}', 0),
            ('own_mirpur', 'BD', 2, 'leg_dhaka', 'mirpur', '{}', '{}', 1)`);
        const result = await importPlaces(db, input(DATASET));
        expect(result).toMatchObject({ created: 4, updated: 3, conflictCount: 0 });
        expect(rows()).toHaveLength(7);
        // The row the dataset was exported from: the dataset's, its courier ids merged.
        expect(byName("Dhaka")).toMatchObject({ id: "leg_dhaka", source: "bd", key: "pathao:city:1", ids: '{"pathao":"1","steadfast":"D"}', active: 1 });
        // Matched by courier id or name: the merchant's, its status kept.
        expect(byName("Chattogram")).toMatchObject({ id: "own_ctg", source: null, key: "pathao:city:2", active: 0 });
        expect(byName("Mirpur")).toMatchObject({ id: "own_mirpur", source: null, key: "pathao:zone:10" });
        expect(byName("Section 10").parent).toBe("own_mirpur");
    });

    it("keeps a merchant's switch until the dataset itself changes the place", async () => {
        const { db, sqlite, byName } = harness();
        await importPlaces(db, input(DATASET));
        sqlite.exec("UPDATE places SET is_active = 0 WHERE name = 'Gulshan'");
        await importPlaces(db, input(DATASET, { version: "v2" }));
        expect(byName("Gulshan").active).toBe(0);
        const off = DATASET.map((entry) => (entry.name === "Gulshan" ? { ...entry, active: false } : entry));
        await importPlaces(db, input(off, { version: "v3" }));
        await importPlaces(db, input(DATASET, { version: "v4" }));
        expect(byName("Gulshan")).toMatchObject({ active: 1, sourceActive: 1 });
    });

    it("never revives a deleted place and creates its new children deleted", async () => {
        const { db, sqlite, byName } = harness();
        await importPlaces(db, input(DATASET.slice(0, 5)));
        sqlite.exec("UPDATE places SET deleted_at = 1700000000 WHERE name = 'Mirpur'");
        const result = await importPlaces(db, input(DATASET, { version: "v2" }));
        expect(result).toMatchObject({ skipped: 1, created: 2 });
        expect(byName("Mirpur").deleted).toBe(1);
        expect(byName("Section 10")).toMatchObject({ deleted: 1, parent: "leg_mirpur" });
    });

    it("finishes a version: the dataset's own places it no longer lists turn inactive, nothing else", async () => {
        const { db, sqlite, byName } = harness();
        await importPlaces(db, input(DATASET));
        sqlite.exec(`INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata)
            VALUES ('mine', 'BD', 2, 'leg_dhaka', 'My own thana', '{}', '{}')`);
        const next = DATASET.filter((entry) => entry.name !== "Agrabad" && entry.name !== "Gulshan");
        const result = await importPlaces(db, input(next, { version: "v2", finish: true }));
        expect(result.deactivated).toBe(2);
        expect(byName("Agrabad")).toMatchObject({ active: 0, sourceActive: 0, deleted: 0 });
        expect(byName("My own thana").active).toBe(1);
        expect(byName("Dhaka").active).toBe(1);
        // Listed again later: it comes back.
        expect((await importPlaces(db, input(DATASET, { version: "v3" }))).updated).toBe(7);
        expect(byName("Agrabad").active).toBe(1);
    });

    it("reports a name another active sibling holds, and settles it on the next import", async () => {
        const { db, byName, rows } = harness();
        await importPlaces(db, input(DATASET));
        // Pathao re-keys Mirpur: the new key arrives while the old one is still active.
        const rekeyed = [...DATASET.filter((entry) => entry.name !== "Mirpur" && entry.parent !== "pathao:zone:10"), zone(12, 1, "Mirpur")];
        const first = await importPlaces(db, input(rekeyed, { version: "v2", finish: true }));
        expect(first.conflicts).toEqual([{ key: "pathao:zone:12", reason: "name_taken" }]);
        expect(rows().filter((row) => row.name === "Mirpur").map((row) => [row.key, row.active])).toEqual([
            ["pathao:zone:10", 0],
            ["pathao:zone:12", 0],
        ]);
        const second = await importPlaces(db, input(rekeyed, { version: "v2" }));
        expect(second.conflictCount).toBe(0);
        expect(rows().filter((row) => row.name === "Mirpur" && row.active === 1).map((row) => row.key)).toEqual(["pathao:zone:12"]);
        expect(byName("Dhaka").active).toBe(1);
    });

    it("reports places whose parent is unknown and skips them", async () => {
        const { db, rows } = harness();
        const result = await importPlaces(db, input([zone(10, 1, "Mirpur")]));
        expect(result).toMatchObject({ created: 0, conflictCount: 1, conflicts: [{ key: "pathao:zone:10", reason: "parent_missing" }] });
        expect(rows()).toEqual([]);
    });

    it("refuses a malformed call before any database work", async () => {
        const { db, queries } = harness();
        await expect(importPlaces(db, input([city(1, "A"), city(1, "B")]))).rejects.toThrow(/twice/);
        await expect(importPlaces(db, input([{ ...city(1, "A"), level: 4 }]))).rejects.toThrow(/level from 1 to 3/);
        await expect(importPlaces(db, input([{ ...city(1, "A"), parent: "pathao:city:9" }]))).rejects.toThrow(/no parent/);
        await expect(importPlaces(db, input([city(1, " ")]))).rejects.toThrow(/name/);
        await expect(importPlaces(db, input([], { country: "Bangladesh" }))).rejects.toThrow(/country/);
        await expect(importPlaces(db, input([], { source: "BD Pack" }))).rejects.toThrow(/source/);
        await expect(importPlaces(db, input(Array.from({ length: 501 }, (_, index) => city(index + 1, `C${index}`))))).rejects.toThrow(/500/);
        expect(queries).toEqual([]);
    });

    it("imports any country with its own depth", async () => {
        const { db, byName } = harness();
        await importPlaces(db, {
            country: "IN",
            source: "in-post",
            version: "2026-10",
            places: [
                { key: "in:mh", level: 1, parent: null, name: "Maharashtra", externalIds: {}, active: true },
                { key: "in:mumbai", level: 2, parent: "in:mh", name: "Mumbai", externalIds: {}, active: true },
                { key: "in:andheri", level: 3, parent: "in:mumbai", name: "Andheri", externalIds: {}, active: true },
                { key: "in:versova", level: 4, parent: "in:andheri", name: "Versova", externalIds: { delhivery: "400061" }, active: true },
            ],
        });
        expect(byName("Versova")).toMatchObject({ country: "IN", level: 4, source: "in-post", ids: '{"delhivery":"400061"}' });
    });

    it("keeps every statement within D1's 100 bound parameters for a full chunk", async () => {
        const { db, queries } = harness();
        const many = [
            city(1, "Dhaka"),
            ...Array.from({ length: 30 }, (_, index) => zone(1000 + index, 1, `Thana ${index}`)),
            ...Array.from({ length: 469 }, (_, index) => area(5000 + index, 1000 + (index % 30), `Area ${index}`)),
        ];
        expect((await importPlaces(db, input(many))).created).toBe(500);
        expect(Math.max(...queries.map((query) => query.values))).toBeLessThan(20);
        expect(queries.length).toBeLessThanOrEqual(12);
    });
});
