// Migration 0114 (Markets step 3b): shipping zones by region. Over a
// populated 0113 store, the rates without a zone ("Everywhere else", which
// served only Bangladesh) become the zone "Bangladesh" with the region BD:
// the same rate ids, fees and thresholds; local pickup stays store-wide and
// its revision document becomes delivery_pickup. The database keeps one zone
// per region, refuses a live delivery rate without a zone, fences priced
// checkouts and advances the `ship` cache key on every region write.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0114_shipping_zones";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers of delivery_zone_regions verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect([...new Set(triggers.map((trigger) => trigger.table))]).toEqual(["delivery_zone_regions"]);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["delivery_zone_regions"]);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|`/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0113 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0114_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0114_"));
    return db;
  }

  const places = `
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata)
      VALUES ('city_dhaka', 'Dhaka', 'city', NULL, '{}', '{}'),
             ('zone_mirpur', 'Mirpur', 'zone', 'city_dhaka', '{}', '{}');
  `;

  it("turns the Everywhere else rates into the zone Bangladesh and keeps pickup store-wide", () => {
    const database = migrate((seeded) => {
      seeded.exec(`
        ${places}
        INSERT INTO delivery_zones (id, name, sort_order) VALUES ('dz_dhaka', 'Inside Dhaka', 0), ('dz_near', 'Near Dhaka', 4);
        INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('city_dhaka', 'dz_dhaka');
        INSERT INTO shipping_methods (id, name, fee_minor, free_over_minor, zone_id, kind, sort_order)
          VALUES ('sm_inside', 'Inside Dhaka', 6000, NULL, 'dz_dhaka', 'delivery', 0),
                 ('sm_outside', 'Outside Dhaka', 12000, 300000, NULL, 'delivery', 0),
                 ('sm_express', 'Express', 20000, NULL, NULL, 'delivery', 1);
        INSERT INTO shipping_methods (id, name, fee_minor, zone_id, kind, pickup_address, sort_order)
          VALUES ('sm_pickup', 'Shop pickup', 0, NULL, 'pickup', 'House 1, Dhanmondi', 2);
        INSERT INTO shipping_methods (id, name, fee_minor, zone_id, kind, deleted_at)
          VALUES ('sm_old', 'Old flat rate', 5000, NULL, 'delivery', 1700000000);
        INSERT INTO settings (id, category, key, value, type, revision)
          VALUES ('set_elsewhere', 'delivery_everywhere_else', 'document', '{}', 'json', 7);
      `);
    });
    expect(database.prepare("SELECT id, name, sort_order FROM delivery_zones ORDER BY sort_order").all()).toEqual([
      { id: "dz_dhaka", name: "Inside Dhaka", sort_order: 0 },
      { id: "dz_near", name: "Near Dhaka", sort_order: 4 },
      { id: "dz_bd", name: "Bangladesh", sort_order: 5 },
    ]);
    expect(database.prepare("SELECT country_code, admin_area, postal_prefix, zone_id FROM delivery_zone_regions").all())
      .toEqual([{ country_code: "BD", admin_area: "", postal_prefix: "", zone_id: "dz_bd" }]);
    expect(database.prepare("SELECT id, zone_id, kind, fee_minor, free_over_minor FROM shipping_methods ORDER BY id").all()).toEqual([
      { id: "sm_express", zone_id: "dz_bd", kind: "delivery", fee_minor: 20000, free_over_minor: null },
      { id: "sm_inside", zone_id: "dz_dhaka", kind: "delivery", fee_minor: 6000, free_over_minor: null },
      // A removed rate keeps no zone: orders still reference it.
      { id: "sm_old", zone_id: null, kind: "delivery", fee_minor: 5000, free_over_minor: null },
      { id: "sm_outside", zone_id: "dz_bd", kind: "delivery", fee_minor: 12000, free_over_minor: 300000 },
      { id: "sm_pickup", zone_id: null, kind: "pickup", fee_minor: 0, free_over_minor: null },
    ]);
    expect(database.prepare("SELECT category, revision FROM settings WHERE id = 'set_elsewhere'").get())
      .toEqual({ category: "delivery_pickup", revision: 7 });
  });

  it("creates no zone for a store without Everywhere else rates", () => {
    const database = migrate((seeded) => {
      seeded.exec(`
        INSERT INTO shipping_methods (id, name, fee_minor, zone_id, kind, pickup_address)
          VALUES ('sm_pickup', 'Shop pickup', 0, NULL, 'pickup', 'House 1');
      `);
    });
    expect(database.prepare("SELECT count(*) AS n FROM delivery_zones").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM delivery_zone_regions").get()).toEqual({ n: 0 });
  });

  it("refuses a live delivery rate without a zone", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO delivery_zones (id, name) VALUES ('dz_us', 'United States')");
    expect(() => database.exec("INSERT INTO shipping_methods (id, name, fee_minor) VALUES ('sm_x', 'Flat', 100)"))
      .toThrow(/SHIPPING_RATE_ZONE_REQUIRED/);
    database.exec("INSERT INTO shipping_methods (id, name, fee_minor, zone_id) VALUES ('sm_us', 'Standard', 900, 'dz_us')");
    expect(() => database.exec("UPDATE shipping_methods SET zone_id = NULL WHERE id = 'sm_us'")).toThrow(/SHIPPING_RATE_ZONE_REQUIRED/);
    // A zone with live rates can't vanish under them; removing the rates first can.
    expect(() => database.exec("DELETE FROM delivery_zones WHERE id = 'dz_us'")).toThrow(/SHIPPING_RATE_ZONE_REQUIRED/);
    database.exec("UPDATE shipping_methods SET deleted_at = 1700000000 WHERE id = 'sm_us'");
    database.exec("DELETE FROM delivery_zones WHERE id = 'dz_us'");
    expect(database.prepare("SELECT zone_id, deleted_at FROM shipping_methods WHERE id = 'sm_us'").get())
      .toEqual({ zone_id: null, deleted_at: 1700000000 });
    // Local pickup has no zone.
    database.exec("INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address) VALUES ('sm_p', 'Pickup', 0, 'pickup', 'House 1')");
  });

  it("keeps one zone per region and checks each region's shape", () => {
    const database = migrate(() => undefined);
    database.exec(`
      INSERT INTO delivery_zones (id, name) VALUES ('dz_us', 'United States'), ('dz_ca', 'California');
      INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('US', 'dz_us');
      INSERT INTO delivery_zone_regions (country_code, admin_area, zone_id) VALUES ('US', 'CA', 'dz_ca');
      INSERT INTO delivery_zone_regions (country_code, postal_prefix, zone_id) VALUES ('US', '941', 'dz_ca');
    `);
    const insert = (country: string, adminArea: string, postalPrefix: string, zone = "dz_ca") =>
      database.prepare("INSERT INTO delivery_zone_regions (country_code, admin_area, postal_prefix, zone_id) VALUES (?, ?, ?, ?)")
        .run(country, adminArea, postalPrefix, zone);
    expect(() => insert("US", "", "", "dz_ca")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert("US", "CA", "", "dz_us")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert("us", "", "", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("USA", "", "", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("US", "NY", "100", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("US", " NY", "", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("GB", "", "sw1 a", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("GB", "", "SW1AAAAAAAA", "dz_ca")).toThrow(/CHECK/);
    expect(() => insert("CA", "", "", "dz_missing")).toThrow(/FOREIGN KEY/);
    // A zone takes its regions with it.
    database.exec("DELETE FROM delivery_zones WHERE id = 'dz_ca'");
    expect(database.prepare("SELECT country_code, admin_area, postal_prefix, zone_id FROM delivery_zone_regions").all())
      .toEqual([{ country_code: "US", admin_area: "", postal_prefix: "", zone_id: "dz_us" }]);
  });

  it("fences a priced checkout and advances the shipping key on every region write", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO delivery_zones (id, name) VALUES ('dz_us', 'United States')");
    const revision = () => (database.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    const ship = () => (database.prepare("SELECT seq FROM cache_dep WHERE dep = 'ship'").get() as { seq: number } | undefined)?.seq ?? 0;
    for (const sql of [
      "INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('US', 'dz_us')",
      "UPDATE delivery_zone_regions SET admin_area = 'CA' WHERE country_code = 'US'",
      "DELETE FROM delivery_zone_regions WHERE country_code = 'US'",
    ]) {
      const [before, beforeShip] = [revision(), ship()];
      database.exec(sql);
      expect(revision(), sql).toBeGreaterThan(before);
      expect(ship(), sql).toBeGreaterThan(beforeShip);
    }
  });

  it("keeps an agent context's destination country in ISO form", () => {
    const database = migrate(() => undefined);
    const columns = (database.prepare("PRAGMA table_info(agent_storefront_contexts)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["country_code", "admin_area", "postal_code"]));
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_storefront_contexts'").get() as { sql: string };
    expect(table.sql).toContain("agent_storefront_contexts_country_shape");
  });
});
