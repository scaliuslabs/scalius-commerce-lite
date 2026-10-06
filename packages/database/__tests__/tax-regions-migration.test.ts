// Migration 0116 (Markets step 3c): tax regions, the tax provider and
// prices_include_tax per market. Over a populated 0115 store, today's rates
// become Bangladesh regions (the store-wide rates the region BD, each
// City/Thana/Area rate its place's region, combinable), soft-deleted rates
// are not carried over, every market carries the store-wide flag and the
// flag leaves tax_settings. The database keeps one region per scope, refuses
// a sub-region without its country, fences priced checkouts on region, rate
// and market-flag writes and advances the `tax` cache key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0116_tax_regions";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers of tax_regions, the rebuilt tax_rates and tax_settings verbatim", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      "cdep_tax_rates_ins", "cdep_tax_rates_del", "cdep_tax_rates_upd", "cdep_tax_settings_upd",
      "cdep_tax_regions_ins", "cdep_tax_regions_del", "cdep_tax_regions_upd",
    ]);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["tax_regions"]);
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
    expect(sqlite).not.toMatch(/\bCASE\b/i);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|`/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0115 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0116_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0116_"));
    return db;
  }

  const store = (pricesIncludeTax: 0 | 1) => `
    INSERT INTO tax_classes (id, name) VALUES ('taxc_std', 'Standard'), ('taxc_food', 'Food');
    INSERT INTO tax_settings (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
      VALUES ('default', 1, ${pricesIncludeTax}, 1, 'taxc_std', 'VAT', 4);
    INSERT INTO tax_rates (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, priority, is_compound, is_active, version)
      VALUES ('taxr_vat', 'taxc_std', 'VAT', 1500, 'all', NULL, NULL, 0, 0, 1, 3),
             ('taxr_food', 'taxc_food', 'Food VAT', 500, 'all', NULL, NULL, 0, 0, 1, 1),
             ('taxr_dhaka', 'taxc_std', 'Dhaka surcharge', 200, 'city', 'city_dhaka', 'Dhaka', 1, 1, 1, 2),
             ('taxr_mirpur', 'taxc_std', 'Mirpur levy', 100, 'zone', 'zone_mirpur', 'Mirpur', 2, 0, 0, 1),
             ('taxr_mirpur2', 'taxc_food', 'Mirpur food levy', 50, 'zone', 'zone_mirpur', 'Mirpur', 0, 0, 1, 1);
    INSERT INTO tax_rates (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, deleted_at, is_active)
      VALUES ('taxr_gone', 'taxc_std', 'Old rate', 700, 'area', 'area_gone', 'Gone', 1700000000, 0);
    INSERT INTO markets (id, handle, name, status, is_backup, price_increment_minor)
      VALUES ('mkt_in', 'india', 'India', 'active', 0, NULL);
  `;

  it("turns today's rates into Bangladesh regions with the same rates and the market's flag", () => {
    const database = migrate((seeded) => seeded.exec(store(1)));
    expect(database.prepare("SELECT id, country_code, admin_area, postal_prefix, place_type, place_id, provider_id FROM tax_regions ORDER BY id").all())
      .toEqual([
        { id: "txreg_bd", country_code: "BD", admin_area: "", postal_prefix: "", place_type: null, place_id: null, provider_id: null },
        { id: "txreg_bd_city_dhaka", country_code: "BD", admin_area: "", postal_prefix: "", place_type: "city", place_id: "city_dhaka", provider_id: null },
        { id: "txreg_bd_zone_mirpur", country_code: "BD", admin_area: "", postal_prefix: "", place_type: "zone", place_id: "zone_mirpur", provider_id: null },
      ]);
    expect(database.prepare("SELECT id, tax_class_id, tax_region_id, name, rate_bps, priority, is_compound, combinable, is_active, version FROM tax_rates ORDER BY id").all())
      .toEqual([
        { id: "taxr_dhaka", tax_class_id: "taxc_std", tax_region_id: "txreg_bd_city_dhaka", name: "Dhaka surcharge", rate_bps: 200, priority: 1, is_compound: 1, combinable: 1, is_active: 1, version: 2 },
        { id: "taxr_food", tax_class_id: "taxc_food", tax_region_id: "txreg_bd", name: "Food VAT", rate_bps: 500, priority: 0, is_compound: 0, combinable: 0, is_active: 1, version: 1 },
        { id: "taxr_mirpur", tax_class_id: "taxc_std", tax_region_id: "txreg_bd_zone_mirpur", name: "Mirpur levy", rate_bps: 100, priority: 2, is_compound: 0, combinable: 1, is_active: 0, version: 1 },
        { id: "taxr_mirpur2", tax_class_id: "taxc_food", tax_region_id: "txreg_bd_zone_mirpur", name: "Mirpur food levy", rate_bps: 50, priority: 0, is_compound: 0, combinable: 1, is_active: 1, version: 1 },
        { id: "taxr_vat", tax_class_id: "taxc_std", tax_region_id: "txreg_bd", name: "VAT", rate_bps: 1500, priority: 0, is_compound: 0, combinable: 0, is_active: 1, version: 3 },
      ]);
    // Every market carries the store-wide flag, which leaves tax_settings.
    expect(database.prepare("SELECT id, prices_include_tax FROM markets ORDER BY id").all())
      .toEqual([{ id: "mkt_backup", prices_include_tax: 1 }, { id: "mkt_in", prices_include_tax: 1 }]);
    const settingsColumns = (database.prepare("PRAGMA table_info(tax_settings)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(settingsColumns).not.toContain("prices_include_tax");
    expect(database.prepare("SELECT enabled, tax_shipping, default_tax_class_id, display_label, provider_id, version FROM tax_settings").get())
      .toEqual({ enabled: 1, tax_shipping: 1, default_tax_class_id: "taxc_std", display_label: "VAT", provider_id: "system", version: 4 });
    const rateColumns = (database.prepare("PRAGMA table_info(tax_rates)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(rateColumns).not.toEqual(expect.arrayContaining(["jurisdiction_type"]));
    expect(rateColumns).not.toContain("deleted_at");
    // The snapshots keep the jurisdiction and the provider.
    const snapshotColumns = (database.prepare("PRAGMA table_info(order_item_tax_snapshots)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(snapshotColumns).toEqual(expect.arrayContaining(["country_code", "tax_region_id", "provider_id"]));
    const orderColumns = (database.prepare("PRAGMA table_info(order_tax_snapshots)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(orderColumns).toEqual(expect.arrayContaining(["provider_id", "provider_calculation_id"]));
  });

  it("creates no region for a store without rates and keeps an exclusive flag", () => {
    const database = migrate((seeded) => seeded.exec(`
      INSERT INTO tax_settings (id, enabled, prices_include_tax, version) VALUES ('default', 0, 0, 1);
    `));
    expect(database.prepare("SELECT count(*) AS n FROM tax_regions").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT prices_include_tax FROM markets").all()).toEqual([{ prices_include_tax: 0 }]);
  });

  it("keeps one region per scope, needs the country's region and checks each shape", () => {
    const database = migrate(() => undefined);
    const insert = (id: string, country: string, adminArea = "", postalPrefix = "", placeType: string | null = null, placeId: string | null = null, provider: string | null = null) =>
      database.prepare("INSERT INTO tax_regions (id, country_code, admin_area, postal_prefix, place_type, place_id, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, country, adminArea, postalPrefix, placeType, placeId, provider);
    expect(() => insert("r_ca", "US", "CA")).toThrow(/TAX_REGION_COUNTRY_REQUIRED/);
    insert("r_us", "US");
    insert("r_ca", "US", "CA");
    insert("r_941", "US", "", "941");
    expect(() => insert("r_us2", "US")).toThrow(/UNIQUE/);
    expect(() => insert("r_ca2", "US", "CA")).toThrow(/UNIQUE/);
    expect(() => insert("r_x", "us")).toThrow(/CHECK/);
    expect(() => insert("r_x", "US", "NY", "100")).toThrow(/CHECK/);
    expect(() => insert("r_x", "US", "", "", "city", "city_dhaka")).toThrow(/CHECK/);
    expect(() => insert("r_x", "FR", "", "", "city", null)).toThrow(/CHECK/);
    // Only a country region names a provider, and only a well-formed one.
    expect(() => insert("r_x", "US", "NY", "", null, null, "acme.tax:avalara")).toThrow(/CHECK/);
    expect(() => insert("r_gb", "GB", "", "", null, null, "avalara")).toThrow(/CHECK/);
    insert("r_gb", "GB", "", "", null, null, "acme.tax:avalara");
    insert("r_bd", "BD");
    insert("r_dhaka", "BD", "", "", "city", "city_dhaka");
    expect(() => insert("r_dhaka2", "BD", "", "", "zone", "city_dhaka")).toThrow(/UNIQUE/);
    // A scope never changes; a country region goes after its sub-regions.
    expect(() => database.exec("UPDATE tax_regions SET admin_area = 'NY' WHERE id = 'r_ca'")).toThrow(/TAX_REGION_SCOPE_IMMUTABLE/);
    database.exec("UPDATE tax_regions SET provider_id = 'acme.tax:avalara', version = version + 1 WHERE id = 'r_us'");
    expect(() => database.exec("DELETE FROM tax_regions WHERE id = 'r_us'")).toThrow(/TAX_REGION_HAS_SUBREGIONS/);
    database.exec("INSERT INTO tax_classes (id, name) VALUES ('taxc_std', 'Standard')");
    database.exec("INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps) VALUES ('taxr_ca', 'taxc_std', 'r_ca', 'CA', 725)");
    expect(() => database.exec("INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps) VALUES ('taxr_x', 'taxc_std', 'r_missing', 'X', 1)"))
      .toThrow(/FOREIGN KEY/);
    database.exec("DELETE FROM tax_regions WHERE country_code = 'US' AND (admin_area <> '' OR postal_prefix <> '')");
    database.exec("DELETE FROM tax_regions WHERE id = 'r_us'");
    // A region takes its rates with it.
    expect(database.prepare("SELECT count(*) AS n FROM tax_rates").get()).toEqual({ n: 0 });
    expect(() => database.exec("UPDATE tax_settings SET provider_id = 'avalara'")).not.toThrow();
    database.exec("INSERT INTO tax_settings (id) VALUES ('default')");
    expect(() => database.exec("UPDATE tax_settings SET provider_id = 'avalara'")).toThrow(/CHECK/);
    database.exec("UPDATE tax_settings SET provider_id = 'acme.tax:avalara'");
  });

  it("fences a priced checkout and advances the tax key on region, rate and market-flag writes", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO tax_classes (id, name) VALUES ('taxc_std', 'Standard')");
    const revision = () => (database.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    const tax = () => (database.prepare("SELECT seq FROM cache_dep WHERE dep = 'tax'").get() as { seq: number } | undefined)?.seq ?? 0;
    for (const sql of [
      "INSERT INTO tax_regions (id, country_code) VALUES ('r_us', 'US')",
      "UPDATE tax_regions SET provider_id = 'acme.tax:avalara' WHERE id = 'r_us'",
      "INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps) VALUES ('taxr_us', 'taxc_std', 'r_us', 'Sales tax', 600)",
      "UPDATE tax_rates SET combinable = 1 WHERE id = 'taxr_us'",
      "DELETE FROM tax_rates WHERE id = 'taxr_us'",
      "DELETE FROM tax_regions WHERE id = 'r_us'",
    ]) {
      const [before, beforeTax] = [revision(), tax()];
      database.exec(sql);
      expect(revision(), sql).toBeGreaterThan(before);
      expect(tax(), sql).toBeGreaterThan(beforeTax);
    }
    const before = revision();
    database.exec("UPDATE markets SET prices_include_tax = 1 WHERE id = 'mkt_backup'");
    expect(revision()).toBeGreaterThan(before);
    const unchanged = revision();
    database.exec("UPDATE markets SET name = 'Home' WHERE id = 'mkt_backup'");
    expect(revision()).toBe(unchanged);
  });
});
