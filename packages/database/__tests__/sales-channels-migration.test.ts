// Migration 0122 (Markets step 5): sales channels, product publications and
// channel stock locations. It applies over a populated 0121 store without
// changing what any surface lists: every product is published to every
// channel except that the feed flag's products leave the feeds and AI agents,
// every channel sells every location, orders keep their surface's channel and
// the default location takes the store's country. The database keeps the
// online store, a channel's identity and an order's channel, publishes new
// products everywhere, links new channels and locations, fences checkout when
// a product leaves a channel, and the generated triggers advance the keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, CACHE_DEP_LATER_TRIGGERS, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { eventOutboxPostgresStatements, eventOutboxSqliteStatements } from "../scripts/event-outbox-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0122_sales_channels";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache and event triggers verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["sales_channels", "product_channel_publications", "sales_channel_locations"]);
    expect(Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME).map(([trigger]) => trigger))
      .toEqual(["cdep_products_upd", "cdep_products_seo", "cdep_product_variants_chstock", "cdep_product_variants_chstock_old"]);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
    // The reinstalled product triggers no longer name the dropped feed flag.
    for (const trigger of triggers.filter((entry) => entry.table === "products")) {
      expect(trigger.sqlite).not.toContain("exclude_from_product_feed");
    }
    for (const statement of eventOutboxSqliteStatements(NAME)) expect(sqlite).toContain(statement);
    for (const statement of eventOutboxPostgresStatements(NAME)) expect(postgres).toContain(statement);
    expect(eventOutboxSqliteStatements(NAME)).toHaveLength(4);
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|json_remove|WHERE 1 /i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0121 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void = () => undefined): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0122_" });
    db.exec(`
      INSERT INTO products (id, name, price_minor, slug, is_active, exclude_from_product_feed, created_at)
        VALUES ('p_tee', 'Tee', 50000, 'tee', 1, 0, 1700000000), ('p_cap', 'Cap', 20000, 'cap', 1, 1, 1700000000);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1), ('v_cap', 'p_cap', 'CAP-1', 20000, 5, 0, 1, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, channel)
        VALUES ('o_web', 'A', '+8801711111111', 'H', 'c', 'z', 'pending', 'online_store'),
               ('o_bot', 'B', '+8801711111112', 'H', 'c', 'z', 'pending', 'agent'),
               ('o_staff', 'C', '+8801711111113', 'H', 'c', 'z', 'pending', 'admin');
      INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING;
    `);
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0122_"));
    return db;
  }

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;
  const revision = () => (db!.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;

  it("seeds the built-in channels, links every location and publishes every product, keeping the feed flag's choice", () => {
    const database = migrate();
    expect(database.prepare("SELECT id, handle, kind, status, plugin_id AS pluginId FROM sales_channels ORDER BY position").all()).toEqual([
      { id: "sc_online_store", handle: "online-store", kind: "online_store", status: "active", pluginId: null },
      { id: "sc_google", handle: "google", kind: "catalog_feed", status: "active", pluginId: null },
      { id: "sc_meta", handle: "meta", kind: "catalog_feed", status: "active", pluginId: null },
      { id: "sc_agents", handle: "agents", kind: "agent", status: "active", pluginId: null },
    ]);
    expect(database.prepare("SELECT channel_id AS channel, location_id AS location FROM sales_channel_locations ORDER BY channel_id").all()).toEqual([
      { channel: "sc_agents", location: "loc_default" },
      { channel: "sc_google", location: "loc_default" },
      { channel: "sc_meta", location: "loc_default" },
      { channel: "sc_online_store", location: "loc_default" },
    ]);
    const publications = database.prepare(`
      SELECT product_id AS product, channel_id AS channel, published_at AS publishedAt, unpublished_at IS NULL AS published
      FROM product_channel_publications ORDER BY product_id, channel_id
    `).all();
    expect(publications).toEqual([
      { product: "p_cap", channel: "sc_agents", publishedAt: 1700000000, published: 0 },
      { product: "p_cap", channel: "sc_google", publishedAt: 1700000000, published: 0 },
      { product: "p_cap", channel: "sc_meta", publishedAt: 1700000000, published: 0 },
      { product: "p_cap", channel: "sc_online_store", publishedAt: 1700000000, published: 1 },
      { product: "p_tee", channel: "sc_agents", publishedAt: 1700000000, published: 1 },
      { product: "p_tee", channel: "sc_google", publishedAt: 1700000000, published: 1 },
      { product: "p_tee", channel: "sc_meta", publishedAt: 1700000000, published: 1 },
      { product: "p_tee", channel: "sc_online_store", publishedAt: 1700000000, published: 1 },
    ]);
    // One truth: the flag is gone.
    const productColumns = (database.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(productColumns).not.toContain("exclude_from_product_feed");
    // Backfilling emitted no events.
    expect(database.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'product.publication_changed'").get()).toEqual({ n: 0 });
  });

  it("gives every order its surface's channel and keeps it", () => {
    const database = migrate();
    expect(database.prepare("SELECT id, sales_channel_id AS channel FROM orders ORDER BY id").all()).toEqual([
      { id: "o_bot", channel: "sc_agents" },
      { id: "o_staff", channel: "sc_online_store" },
      { id: "o_web", channel: "sc_online_store" },
    ]);
    database.exec("INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status) VALUES ('o_raw', 'D', '+8801711111114', 'H', 'c', 'z', 'pending')");
    expect(database.prepare("SELECT sales_channel_id AS channel FROM orders WHERE id = 'o_raw'").get()).toEqual({ channel: "sc_online_store" });
    expect(() => database.exec("UPDATE orders SET sales_channel_id = 'sc_google' WHERE id = 'o_web'")).toThrow(/immutable/);
    expect(() => database.exec("DELETE FROM sales_channels WHERE id = 'sc_agents'")).toThrow(/SALES_CHANNEL_HAS_ORDERS/);
    database.exec("DELETE FROM sales_channels WHERE id = 'sc_meta'");
    expect(database.prepare("SELECT count(*) AS n FROM product_channel_publications WHERE channel_id = 'sc_meta'").get()).toEqual({ n: 0 });
  });

  it("keeps the online store and a channel's identity", () => {
    const database = migrate();
    expect(() => database.exec("DELETE FROM sales_channels WHERE id = 'sc_online_store'")).toThrow(/SALES_CHANNEL_ONLINE_STORE_REQUIRED/);
    expect(() => database.exec("UPDATE sales_channels SET status = 'inactive' WHERE id = 'sc_online_store'")).toThrow(/SALES_CHANNEL_ONLINE_STORE_REQUIRED/);
    expect(() => database.exec("UPDATE sales_channels SET kind = 'pos' WHERE id = 'sc_google'")).toThrow(/SALES_CHANNEL_IDENTITY_IMMUTABLE/);
    expect(() => database.exec("INSERT INTO sales_channels (id, handle, name, kind) VALUES ('sc_tiktok', 'tiktok', 'TikTok', 'app')")).toThrow(/sales_channels_app_plugin/);
    expect(() => database.exec("INSERT INTO sales_channels (id, handle, name, kind) VALUES ('sc_bad id', 'bad', 'Bad', 'pos')")).toThrow(/sales_channels_id_shape/);
    database.exec("UPDATE sales_channels SET status = 'inactive', name = 'Meta' WHERE id = 'sc_meta'");
    expect(database.prepare("SELECT status, name FROM sales_channels WHERE id = 'sc_meta'").get()).toEqual({ status: "inactive", name: "Meta" });
  });

  it("publishes a new product everywhere and links new channels and locations to every other", () => {
    const database = migrate();
    database.exec(`
      INSERT INTO sales_channels (id, handle, name, kind, plugin_id) VALUES ('acme.tiktok:shop', 'acme.tiktok:shop', 'TikTok Shop', 'app', 'acme.tiktok');
      INSERT INTO inventory_locations (id, name, code, country_code) VALUES ('loc_dhk', 'Dhaka', 'DHK', 'BD');
      INSERT INTO products (id, name, price_minor, slug) VALUES ('p_new', 'New', 1000, 'new');
    `);
    expect(database.prepare("SELECT channel_id AS channel FROM product_channel_publications WHERE product_id = 'p_new' AND unpublished_at IS NULL ORDER BY channel_id").all())
      .toEqual([{ channel: "acme.tiktok:shop" }, { channel: "sc_agents" }, { channel: "sc_google" }, { channel: "sc_meta" }, { channel: "sc_online_store" }]);
    expect(database.prepare("SELECT count(*) AS n FROM sales_channel_locations").get()).toEqual({ n: 10 });
    expect(database.prepare("SELECT location_id AS location FROM sales_channel_locations WHERE channel_id = 'acme.tiktok:shop' ORDER BY location_id").all())
      .toEqual([{ location: "loc_default" }, { location: "loc_dhk" }]);
  });

  it("fences checkout when a product leaves a channel or a channel switches off, not when one is published", () => {
    const database = migrate();
    database.exec("INSERT INTO products (id, name, price_minor, slug) VALUES ('p_new', 'New', 1000, 'new')");
    const start = revision();
    database.exec("UPDATE product_channel_publications SET published_at = unixepoch(), unpublished_at = NULL WHERE product_id = 'p_cap' AND channel_id = 'sc_google'");
    expect(revision()).toBe(start);
    database.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'p_tee' AND channel_id = 'sc_online_store'");
    expect(revision()).toBe(start + 1);
    database.exec("DELETE FROM product_channel_publications WHERE product_id = 'p_tee' AND channel_id = 'sc_agents'");
    expect(revision()).toBe(start + 2);
    database.exec("UPDATE sales_channels SET status = 'inactive' WHERE id = 'sc_agents'");
    expect(revision()).toBe(start + 3);
    database.exec("UPDATE sales_channels SET name = 'Bots' WHERE id = 'sc_agents'");
    expect(revision()).toBe(start + 3);
  });

  it("advances the product, discovery and catalogue keys of a publication, and everything for a location link", () => {
    const database = migrate();
    const before = { product: dep("p:p_tee"), seo: dep("lm:seo"), all: dep("lm:all"), search: dep("srch"), store: dep("store") };
    database.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'p_tee' AND channel_id = 'sc_google'");
    expect(dep("p:p_tee")).toBeGreaterThan(before.product);
    expect(dep("lm:seo")).toBeGreaterThan(before.seo);
    expect(dep("lm:all")).toBe(before.all);
    database.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'p_tee' AND channel_id = 'sc_online_store'");
    expect(dep("lm:all")).toBeGreaterThan(before.all);
    expect(dep("srch")).toBeGreaterThan(before.search);
    database.exec("DELETE FROM sales_channel_locations WHERE channel_id = 'sc_meta'");
    expect(dep("store")).toBeGreaterThan(before.store);
  });

  it("moves a SKU's keys on raw stock only once a channel misses a location", () => {
    const database = migrate();
    const stock = (value: number) => database.exec(`UPDATE product_variants SET stock = ${value} WHERE id = 'v_tee'`);
    const start = dep("p:p_tee");
    stock(6);
    expect(dep("p:p_tee")).toBe(start);
    database.exec("INSERT INTO inventory_locations (id, name, code, country_code) VALUES ('loc_dhk', 'Dhaka', 'DHK', 'BD')");
    database.exec("DELETE FROM sales_channel_locations WHERE channel_id = 'sc_online_store' AND location_id = 'loc_dhk'");
    stock(7);
    expect(dep("p:p_tee")).toBeGreaterThan(start);
  });

  it("gives the untouched default location the store's country, and leaves an edited one", () => {
    const moved = migrate((seeded) => seeded.exec("UPDATE market_countries SET country_code = 'US' WHERE market_id = 'mkt_backup'"));
    expect(moved.prepare("SELECT country_code AS country FROM inventory_locations WHERE id = 'loc_default'").get()).toEqual({ country: "US" });
    moved.close();
    const kept = migrate((seeded) => {
      seeded.exec("UPDATE market_countries SET country_code = 'US' WHERE market_id = 'mkt_backup'");
      seeded.exec("UPDATE inventory_locations SET city = 'Dhaka', version = 2 WHERE id = 'loc_default'");
    });
    expect(kept.prepare("SELECT country_code AS country FROM inventory_locations WHERE id = 'loc_default'").get()).toEqual({ country: "BD" });
  });
});
