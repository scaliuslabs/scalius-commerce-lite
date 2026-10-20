// Migration 0118 (the place directory): delivery_locations becomes places,
// one tree of numbered levels for any country. Over a populated 0117 store
// every row keeps its id (zones, tax regions, addresses and courier ids still
// point at it), Bangladesh is its country and its type becomes its level. The
// database keeps a parent one level up in the same country, keeps active
// names unique per parent, fences checkout and advances `loc` on buyer-visible
// changes only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CACHE_DEP_LATER_TABLES,
  CACHE_DEP_LATER_TRIGGERS,
  cacheDepTriggersForMigration,
  retiredCacheDepFunctionDrops,
} from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0118_places";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers of places and the rebuilt zone places verbatim", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect([...new Set(triggers.map((trigger) => trigger.table))].sort()).toEqual(["delivery_zone_locations", "places"]);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table)).toEqual(["places"]);
    expect(Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME).map(([trigger]) => trigger).sort())
      .toEqual(["cdep_delivery_zone_locations_del", "cdep_delivery_zone_locations_ins", "cdep_delivery_zone_locations_upd"]);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
    for (const statement of retiredCacheDepFunctionDrops(NAME)) expect(postgres).toContain(statement);
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|`/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/\bCASE\b/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0117 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0118_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0118_"));
    return db;
  }

  const seedPlaces = (database: DatabaseSync) => database.exec(`
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active, sort_order, created_at, updated_at, deleted_at)
      VALUES ('city_dhaka', 'Dhaka', 'city', NULL, '{"pathao":"1"}', '{}', 1, 2, 1700000000, 1700000100, NULL),
             ('zone_mirpur', 'Mirpur', 'zone', 'city_dhaka', '{"pathao":"10"}', '{}', 1, 0, 1700000000, 1700000000, NULL),
             ('area_s10', 'Section 10', 'area', 'zone_mirpur', '{"pathao":"100"}', '{"home_delivery_available":true}', 1, 0, 1700000000, 1700000000, NULL),
             ('area_old', 'Old area', 'area', 'zone_mirpur', '{}', '{}', 0, 0, 1700000000, 1700000000, 1700000500),
             ('city_ctg', 'Chittagong', 'city', NULL, '{}', '{}', 0, 1, 1700000000, 1700000000, NULL);
    INSERT INTO delivery_zones (id, name) VALUES ('dz_dhaka', 'Inside Dhaka');
    INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('city_dhaka', 'dz_dhaka'), ('area_s10', 'dz_dhaka');
  `);

  it("carries every place over with its id, Bangladesh and its level", () => {
    const database = migrate(seedPlaces);
    expect(database.prepare(`SELECT id, country_code, level, parent_id, name, external_ids, metadata, is_active, sort_order,
        created_at, updated_at, deleted_at, source, source_key, source_version, source_active FROM places ORDER BY id`).all()).toEqual([
      { id: "area_old", country_code: "BD", level: 3, parent_id: "zone_mirpur", name: "Old area", external_ids: "{}", metadata: "{}", is_active: 0, sort_order: 0, created_at: 1700000000, updated_at: 1700000000, deleted_at: 1700000500, source: null, source_key: null, source_version: null, source_active: null },
      { id: "area_s10", country_code: "BD", level: 3, parent_id: "zone_mirpur", name: "Section 10", external_ids: '{"pathao":"100"}', metadata: '{"home_delivery_available":true}', is_active: 1, sort_order: 0, created_at: 1700000000, updated_at: 1700000000, deleted_at: null, source: null, source_key: null, source_version: null, source_active: null },
      { id: "city_ctg", country_code: "BD", level: 1, parent_id: null, name: "Chittagong", external_ids: "{}", metadata: "{}", is_active: 0, sort_order: 1, created_at: 1700000000, updated_at: 1700000000, deleted_at: null, source: null, source_key: null, source_version: null, source_active: null },
      { id: "city_dhaka", country_code: "BD", level: 1, parent_id: null, name: "Dhaka", external_ids: '{"pathao":"1"}', metadata: "{}", is_active: 1, sort_order: 2, created_at: 1700000000, updated_at: 1700000100, deleted_at: null, source: null, source_key: null, source_version: null, source_active: null },
      { id: "zone_mirpur", country_code: "BD", level: 2, parent_id: "city_dhaka", name: "Mirpur", external_ids: '{"pathao":"10"}', metadata: "{}", is_active: 1, sort_order: 0, created_at: 1700000000, updated_at: 1700000000, deleted_at: null, source: null, source_key: null, source_version: null, source_active: null },
    ]);
    expect(database.prepare("SELECT location_id, zone_id FROM delivery_zone_locations ORDER BY location_id").all()).toEqual([
      { location_id: "area_s10", zone_id: "dz_dhaka" },
      { location_id: "city_dhaka", zone_id: "dz_dhaka" },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'delivery_locations'").get()).toBeUndefined();
    // Zone places now reference places: an unknown place is refused, and a
    // deleted place leaves its zone.
    expect(() => database.exec("INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('nowhere', 'dz_dhaka')")).toThrow(/FOREIGN KEY/);
    database.exec("DELETE FROM places WHERE id = 'area_s10'");
    expect(database.prepare("SELECT location_id FROM delivery_zone_locations").all()).toEqual([{ location_id: "city_dhaka" }]);
    const triggers = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'delivery_zone_locations' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(triggers).toEqual([
      "cdep_delivery_zone_locations_del", "cdep_delivery_zone_locations_ins", "cdep_delivery_zone_locations_upd",
      "delivery_zone_locations_checkout_authority_delete", "delivery_zone_locations_checkout_authority_insert",
      "delivery_zone_locations_checkout_authority_update",
    ]);
   }); // The first test also builds the migrated SQLite database.

  it("keeps a parent one level up in the same country", () => {
    const database = migrate(seedPlaces);
    const insert = (id: string, country: string, level: number, parent: string | null, name = id) =>
      database.prepare("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES (?, ?, ?, ?, ?, '{}', '{}')")
        .run(id, country, level, parent, name);
    expect(() => insert("bad_root", "BD", 1, "city_dhaka")).toThrow(/PLACE_PARENT_INVALID/);
    expect(() => insert("bad_orphan", "BD", 2, null)).toThrow(/PLACE_PARENT_INVALID/);
    expect(() => insert("bad_skip", "BD", 3, "city_dhaka")).toThrow(/PLACE_PARENT_INVALID/);
    expect(() => insert("bad_country", "IN", 2, "city_dhaka")).toThrow(/PLACE_PARENT_INVALID/);
    expect(() => insert("bad_shape", "in", 1, null)).toThrow(/CHECK/);
    expect(() => insert("bad_level", "IN", 5, null)).toThrow(/CHECK|PLACE_PARENT_INVALID/);
    insert("in_mh", "IN", 1, null, "Maharashtra");
    insert("in_mumbai", "IN", 2, "in_mh", "Mumbai");
    insert("in_andheri", "IN", 3, "in_mumbai", "Andheri");
    insert("in_versova", "IN", 4, "in_andheri", "Versova");
    expect(() => database.exec("UPDATE places SET parent_id = 'city_dhaka' WHERE id = 'in_andheri'")).toThrow(/PLACE_PARENT_INVALID/);
    // A hard-deleted parent leaves its children without one (ON DELETE SET NULL).
    database.exec("DELETE FROM places WHERE country_code = 'IN'");
    expect(database.prepare("SELECT count(*) AS n FROM places WHERE country_code = 'IN'").get()).toEqual({ n: 0 });
  });

  it("keeps active names unique among a country's top places and a place's children", () => {
    const database = migrate(seedPlaces);
    const insert = (id: string, country: string, level: number, parent: string | null, name: string, active = 1) =>
      database.prepare("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata, is_active) VALUES (?, ?, ?, ?, ?, '{}', '{}', ?)")
        .run(id, country, level, parent, name, active);
    expect(() => insert("dup_city", "BD", 1, null, " dhaka ")).toThrow(/UNIQUE/);
    expect(() => insert("dup_zone", "BD", 2, "city_dhaka", "MIRPUR")).toThrow(/UNIQUE/);
    // Another country, an inactive place and another parent are free to repeat a name.
    insert("in_dhaka", "IN", 1, null, "Dhaka");
    insert("old_dhaka", "BD", 1, null, "Dhaka", 0);
    insert("ctg_mirpur", "BD", 2, "city_ctg", "Mirpur");
  });

  it("fences checkout and advances loc only on buyer-visible changes", () => {
    const database = migrate(seedPlaces);
    const revision = () => (database.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    const loc = () => (database.prepare("SELECT seq FROM cache_dep WHERE dep = 'loc'").get() as { seq: number } | undefined)?.seq ?? 0;
    for (const sql of [
      "UPDATE places SET name = 'Mirpur DOHS' WHERE id = 'zone_mirpur'",
      "UPDATE places SET is_active = 0 WHERE id = 'area_s10'",
      "UPDATE places SET deleted_at = 1700000900 WHERE id = 'area_s10'",
      "INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES ('in_mh', 'IN', 1, NULL, 'Maharashtra', '{}', '{}')",
      "DELETE FROM places WHERE id = 'in_mh'",
    ]) {
      const [fence, key] = [revision(), loc()];
      database.exec(sql);
      expect(revision(), sql).toBeGreaterThan(fence);
      expect(loc(), sql).toBeGreaterThan(key);
    }
    // Import bookkeeping changes nothing a buyer sees.
    const [fence, key] = [revision(), loc()];
    database.exec("UPDATE places SET source = 'bd', source_key = 'pathao:city:1', source_version = 'v2', source_active = 1, updated_at = 1800000000 WHERE id = 'city_dhaka'");
    expect([revision(), loc()]).toEqual([fence, key]);
    // Courier ids: no repricing, but the cached directory moves.
    database.exec("UPDATE places SET external_ids = '{\"pathao\":\"2\"}' WHERE id = 'city_dhaka'");
    expect(revision()).toBe(fence);
    expect(loc()).toBeGreaterThan(key);
  });

  it("keeps one place per source key in a country", () => {
    const database = migrate(seedPlaces);
    database.exec("UPDATE places SET source_key = 'pathao:city:1' WHERE id = 'city_dhaka'");
    expect(() => database.exec("UPDATE places SET source_key = 'pathao:city:1' WHERE id = 'city_ctg'")).toThrow(/UNIQUE/);
    database.exec("INSERT INTO places (id, country_code, level, name, external_ids, metadata, source_key) VALUES ('in_x', 'IN', 1, 'X', '{}', '{}', 'pathao:city:1')");
  });
});
