// The committed Bangladesh dataset (plugins/bangladesh/places) against the stores it
// must serve: the demo store it was exported from (rows under their legacy
// ids, migrated by 0118) and a new store. Both end with the same 11,550 keyed
// places; neither import creates a duplicate, and a second run changes nothing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
} from "@scalius/database/testing/sqlite-d1";
import {
  PLACE_IMPORT_MAX_ENTRIES,
  PLACE_LEVELS,
  placeDatasetCounts,
  serializePlaceDataset,
  type PlaceDatasetEntry,
  type PlaceDatasetManifest,
} from "@scalius/shared/places";
import type { Database } from "@scalius/database/client";

import { importPlaces, type PlaceImportResult } from "./places-import";

const DATASET = join(import.meta.dirname, "../../../../../plugins/bangladesh/places");
const text = readFileSync(join(DATASET, "places.json"), "utf8");
const manifest = JSON.parse(readFileSync(join(DATASET, "manifest.json"), "utf8")) as PlaceDatasetManifest;
const places = JSON.parse(text) as PlaceDatasetEntry[];

async function importDataset(db: Database) {
  const total = { created: 0, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, conflictCount: 0 };
  for (let offset = 0; offset < places.length; offset += PLACE_IMPORT_MAX_ENTRIES) {
    const result: PlaceImportResult = await importPlaces(db, {
      country: manifest.country,
      source: manifest.id,
      version: manifest.sha256,
      places: places.slice(offset, offset + PLACE_IMPORT_MAX_ENTRIES),
      finish: offset + PLACE_IMPORT_MAX_ENTRIES >= places.length,
    });
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
  }
  return total;
}

describe("the Bangladesh dataset", () => {
  it("is what its manifest says, in the dataset's own format", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe(manifest.sha256);
    expect(serializePlaceDataset(places)).toBe(text);
    const { counts, inactive } = placeDatasetCounts(places);
    expect({ counts, inactive }).toEqual({ counts: manifest.counts, inactive: manifest.inactive });
    expect(manifest.levels.map(({ label }) => label))
      .toEqual(PLACE_LEVELS.BD!.map((name) => ({ en: name.en, bn: name.bn })));
  });

  it("adopts the demo store's migrated rows by legacy id: no new place, every reference kept", async () => {
    const sqlite = createMigratedSqlite({ beforeMigration: "0118_" });
    const legacy = new Map(places.map((place) => [place.key, place.legacyId!]));
    const insert = sqlite.prepare(`INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    sqlite.exec("BEGIN");
    for (const place of places) {
      insert.run(
        place.legacyId!,
        place.name,
        ["city", "zone", "area"][place.level - 1]!,
        place.parent ? legacy.get(place.parent)! : null,
        JSON.stringify(place.externalIds),
        JSON.stringify({
          ...(place.homeDelivery !== undefined ? { home_delivery_available: place.homeDelivery } : {}),
          ...(place.pickup !== undefined ? { pickup_available: place.pickup } : {}),
        }),
        place.active ? 1 : 0,
      );
    }
    sqlite.exec(`COMMIT;
      INSERT INTO delivery_zones (id, name) VALUES ('dz_dhaka', 'Inside Dhaka');
      INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('${legacy.get("pathao:city:1")}', 'dz_dhaka');`);
    sqlite.exec(compiledMigrationSql("d1", undefined, "0118_"));

    const { db } = createSqliteD1Database({ sqlite });
    expect(await importDataset(db)).toEqual({ created: 0, updated: places.length, unchanged: 0, skipped: 0, deactivated: 0, conflictCount: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n, count(DISTINCT source_key) AS keys, sum(source = 'bd') AS owned FROM places").get())
      .toEqual({ n: places.length, keys: places.length, owned: places.length });
    expect(sqlite.prepare("SELECT location_id FROM delivery_zone_locations").all()).toEqual([{ location_id: legacy.get("pathao:city:1") }]);
    expect(await importDataset(db)).toMatchObject({ created: 0, updated: 0, unchanged: places.length });
  }, 120_000);

  it("seeds a new store under the dataset's ids", async () => {
    const { db, sqlite } = createSqliteD1Database();
    expect(await importDataset(db)).toMatchObject({ created: places.length, conflictCount: 0 });
    const levels = sqlite.prepare("SELECT level, count(*) AS n, sum(is_active = 0) AS inactive FROM places GROUP BY level ORDER BY level").all() as Array<{ level: number; n: number; inactive: number }>;
    // Junk cities (repeated letters, placeholders) and childless cities are switched off with their ids kept.
    expect(levels).toEqual([
      { level: 1, n: manifest.counts["1"], inactive: 2 },
      { level: 2, n: manifest.counts["2"], inactive: 11 },
      { level: 3, n: manifest.counts["3"], inactive: 41 },
    ]);
    expect(levels.reduce((sum, level) => sum + level.inactive, 0)).toBe(manifest.inactive);
    expect(sqlite.prepare("SELECT id FROM places WHERE source_key = 'pathao:city:1'").get()).toEqual({ id: places[places.findIndex((place) => place.key === "pathao:city:1")]!.legacyId });
  }, 120_000);
});
