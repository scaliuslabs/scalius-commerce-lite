// Migration 0121 (Markets step 4b): the store's languages, translations and
// localized URL handles. It applies over a populated 0120 store: the store
// languages unify the presences' languages and the checkout copies' ones, and
// the default language takes the active checkout copy's language (what
// buyers read at the root). The database keeps a presence in a store
// language, the default language published, a localized handle off every
// source handle of its type, and a resource's translations with it; the
// generated cache dependency triggers advance one resource's `tr:` key (a
// product's parts advance their product's), a handle space and `tr:locales`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, CACHE_DEP_LATER_TRIGGERS, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0121_translations";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["store_languages", "translations", "localized_slugs"]);
    expect(Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME).map(([trigger]) => trigger))
      .toEqual(["cdep_market_presences_locales_ins", "cdep_market_presences_locales_del", "cdep_market_presences_locales_upd"]);
    expect([...new Set(triggers.map((trigger) => trigger.table))])
      .toEqual(["market_presences", "store_languages", "translations", "localized_slugs"]);
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
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|json_remove|WHERE 1;/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0120 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void = () => undefined): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0121_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0121_"));
    return db;
  }

  const seedStore = (database: DatabaseSync) => database.exec(`
    INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active'), ('mkt_np', 'nepal', 'Nepal', 'draft');
    INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en'), ('mkp_np', 'mkt_np', 'subfolder', 'ne-np', 'ne');
    INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
      VALUES ('cl_bn', 'Bangla', 'bn', 1, 0, '{}', '{}'), ('cl_en', 'English', 'en', 0, 1, '{}', '{}'), ('cl_fr', 'French', 'fr-FR', 0, 0, '{}', '{}');
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_tee', 'Tee', 50000, 'tee', 1), ('p_cap', 'Cap', 20000, 'cap', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_tee', 'Size', 'size', 0);
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES ('val_m', 'opt_size', 'M', 'm', 0);
  `);

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;
  const advances = (database: DatabaseSync, sql: string, keys: string[]) => {
    const before = keys.map(dep);
    database.exec(sql);
    return keys.filter((key, index) => dep(key) > before[index]!);
  };

  it("unifies the presences' and the checkout copies' languages; the default takes the active copy's", () => {
    const database = migrate(seedStore);
    expect(database.prepare("SELECT locale, published FROM store_languages ORDER BY locale").all()).toEqual([
      { locale: "bn", published: 1 },
      { locale: "en", published: 1 },
      { locale: "fr", published: 0 },
      { locale: "ne", published: 1 },
    ]);
    expect(database.prepare("SELECT value, locale FROM market_presences ORDER BY value").all()).toEqual([
      { value: "", locale: "bn" },
      { value: "en-in", locale: "en" },
      { value: "ne-np", locale: "ne" },
    ]);
  });

  it("takes the fallback copy's language when no copy is active, and keeps the root's without any", () => {
    const fallback = migrate((seeded) => seeded.exec(`
      INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
        VALUES ('cl_bn', 'Bangla', 'bn', 0, 1, '{}', '{}'), ('cl_fr', 'French', 'fr', 0, 0, '{}', '{}');
    `));
    expect(fallback.prepare("SELECT locale FROM market_presences WHERE value = ''").get()).toEqual({ locale: "bn" });
    expect(fallback.prepare("SELECT locale, published FROM store_languages ORDER BY locale").all()).toEqual([
      { locale: "bn", published: 1 },
      { locale: "en", published: 1 },
      { locale: "fr", published: 0 },
    ]);
    fallback.close();
    const none = migrate();
    expect(none.prepare("SELECT locale FROM market_presences WHERE value = ''").get()).toEqual({ locale: "en" });
    expect(none.prepare("SELECT locale, published FROM store_languages ORDER BY locale").all()).toEqual([{ locale: "en", published: 1 }]);
  });

  it("keeps every presence in a store language and the default language published", () => {
    const database = migrate(seedStore);
    expect(() => database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_de', 'mkt_in', 'subfolder', 'de-in', 'de')"))
      .toThrow(/STORE_LANGUAGE_REQUIRED/);
    database.exec("INSERT INTO store_languages (locale, published) VALUES ('de', 0)");
    // An unpublished language may name a presence (it is not served) but not the root.
    database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_de', 'mkt_in', 'subfolder', 'de-in', 'de')");
    expect(() => database.exec("UPDATE market_presences SET locale = 'fr' WHERE value = ''")).toThrow(/STORE_LANGUAGE_REQUIRED/);
    expect(() => database.exec("UPDATE store_languages SET published = 0 WHERE locale = 'bn'")).toThrow(/STORE_LANGUAGE_DEFAULT_REQUIRED/);
    expect(() => database.exec("DELETE FROM store_languages WHERE locale = 'de'")).toThrow(/STORE_LANGUAGE_IN_USE/);
    expect(() => database.exec("UPDATE store_languages SET locale = 'da' WHERE locale = 'fr'")).toThrow(/STORE_LANGUAGE_IMMUTABLE/);
    expect(() => database.exec("INSERT INTO store_languages (locale, published) VALUES ('EN', 1)")).toThrow(/CHECK/);
    // Publishing a language and moving the root to it is fine; the old default may then be unpublished.
    database.exec("UPDATE store_languages SET published = 1 WHERE locale = 'fr'");
    database.exec("UPDATE market_presences SET locale = 'fr' WHERE value = ''");
    database.exec("UPDATE store_languages SET published = 0 WHERE locale = 'bn'");
    // A removed language takes its translations and handles with it.
    database.exec(`
      INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_bn1', 'product', 'p_tee', 'bn', '{"name":"টি"}');
      INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti', 'p_tee');
      DELETE FROM store_languages WHERE locale = 'bn';
    `);
    expect(database.prepare("SELECT count(*) AS n FROM translations").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM localized_slugs").get()).toEqual({ n: 0 });
  });

  it("checks translations: one per resource, locale and market, with JSON object fields", () => {
    const database = migrate(seedStore);
    database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_a00', 'product', 'p_tee', 'bn', '{\"name\":\"টি\"}')");
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_b00', 'product', 'p_tee', 'bn', '{}')"))
      .toThrow(/UNIQUE/);
    database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, market_id, fields) VALUES ('tr_c00', 'product', 'p_tee', 'en', 'mkt_in', '{\"name\":\"T-shirt\"}')");
    database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_d00', 'product', 'p_tee', 'en', '{\"name\":\"Tee\"}')");
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, market_id, fields) VALUES ('tr_e00', 'product', 'p_tee', 'en', 'mkt_in', '{}')"))
      .toThrow(/UNIQUE/);
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_f00', 'product', 'p_cap', 'bn', '[]')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_g00', 'tag', 'p_cap', 'bn', '{}')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_h00', 'product', 'p_cap', 'zz', '{}')")).toThrow(/FOREIGN KEY/);
    expect(() => database.exec("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('x_i', 'product', 'p_cap', 'bn', '{}')")).toThrow(/CHECK/);
    // A deleted market takes its market-specific translations.
    database.exec("DELETE FROM markets WHERE id = 'mkt_in'");
    expect(database.prepare("SELECT id FROM translations ORDER BY id").all()).toEqual([{ id: "tr_a00" }, { id: "tr_d00" }]);
  });

  it("keeps a localized handle unique and off every source handle of its type, from both sides", () => {
    const database = migrate(seedStore);
    database.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti-shirt', 'p_tee')");
    expect(() => database.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti-shirt', 'p_cap')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => database.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'tupi', 'p_tee')")).toThrow(/UNIQUE/);
    // Another product's source handle is taken; the product's own is not.
    expect(() => database.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'en', 'cap', 'p_tee')")).toThrow(/LOCALIZED_SLUG_TAKEN/);
    database.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'en', 'tee', 'p_tee')");
    expect(() => database.exec("UPDATE localized_slugs SET slug = 'cap' WHERE locale = 'bn'")).toThrow(/LOCALIZED_SLUG_TAKEN/);
    expect(() => database.exec("UPDATE products SET slug = 'ti-shirt' WHERE id = 'p_cap'")).toThrow(/LOCALIZED_SLUG_TAKEN/);
    expect(() => database.exec("INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_new', 'New', 100, 'ti-shirt', 1)")).toThrow(/LOCALIZED_SLUG_TAKEN/);
    // A category may use the handle: types never collide.
    database.exec("INSERT INTO categories (id, name, slug) VALUES ('c_tee', 'Tees', 'ti-shirt')");
    for (const slug of ["Ti", "ti--shirt", "-ti", "ti-", "টি", ""]) {
      expect(() => database.prepare("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('category', 'bn', ?, 'c_tee')").run(slug), slug).toThrow(/CHECK/);
    }
  });

  it("removes a deleted resource's translations and handles", () => {
    const database = migrate(seedStore);
    database.exec(`
      INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES
        ('tr_p00', 'product', 'p_tee', 'bn', '{"name":"টি"}'),
        ('tr_v00', 'product_variant', 'v_tee', 'bn', '{"preorderMessage":"শীঘ্রই"}'),
        ('tr_o00', 'product_option', 'opt_size', 'bn', '{"name":"সাইজ"}'),
        ('tr_ov0', 'product_option_value', 'val_m', 'bn', '{"value":"মাঝারি"}'),
        ('tr_c00', 'product', 'p_cap', 'bn', '{"name":"টুপি"}');
      INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti', 'p_tee');
      DELETE FROM products WHERE id = 'p_tee';
    `);
    expect(database.prepare("SELECT id FROM translations").all()).toEqual([{ id: "tr_c00" }]);
    expect(database.prepare("SELECT count(*) AS n FROM localized_slugs").get()).toEqual({ n: 0 });
  });

  it("advances one resource's key, its product's for a product's parts, the handle space and the locales", () => {
    const database = migrate(seedStore);
    expect(advances(database, "INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_p00', 'product', 'p_tee', 'bn', '{\"name\":\"টি\"}')",
      ["tr:product:p_tee", "tr:product:p_cap", "tr:locales"])).toEqual(["tr:product:p_tee"]);
    expect(advances(database, "INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_v00', 'product_variant', 'v_tee', 'bn', '{}')",
      ["tr:product:p_tee", "tr:product_variant:v_tee"])).toEqual(["tr:product:p_tee"]);
    expect(advances(database, "INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_o00', 'product_option', 'opt_size', 'bn', '{}')",
      ["tr:product:p_tee", "tr:product_option:opt_size"])).toEqual(["tr:product:p_tee"]);
    expect(advances(database, "UPDATE translations SET fields = '{\"value\":\"M\"}', resource_type = 'product_option_value', resource_id = 'val_m' WHERE id = 'tr_o00'",
      ["tr:product:p_tee"])).toEqual(["tr:product:p_tee"]);
    expect(advances(database, "INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_m00', 'menu', 'menu_main', 'bn', '{}')",
      ["tr:menu:menu_main"])).toEqual(["tr:menu:menu_main"]);
    // The timestamp alone is never buyer-visible.
    expect(advances(database, "UPDATE translations SET updated_at = updated_at + 1 WHERE id = 'tr_p00'", ["tr:product:p_tee"])).toEqual([]);
    expect(advances(database, "INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti', 'p_tee')",
      ["tr:product:p_tee", "tr:slugs:product:bn", "tr:slugs:product:en"])).toEqual(["tr:product:p_tee", "tr:slugs:product:bn"]);
    expect(advances(database, "UPDATE store_languages SET published = 1 WHERE locale = 'fr'", ["tr:locales", "mk:*"])).toEqual(["tr:locales", "mk:*"]);
    expect(advances(database, "UPDATE market_presences SET value = 'fr-np', locale = 'fr' WHERE id = 'mkp_np'", ["tr:locales"])).toEqual(["tr:locales"]);
  });
});
