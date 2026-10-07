// PostgreSQL sidecar for 0121_translations, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// the store languages unify the presences' and checkout copies' languages,
// the guards keep presences in store languages and localized handles off
// source handles, a deleted resource takes its translations, and the cache
// triggers advance one resource's key (a product's parts their product's).
// Opt-in, like the other sidecars.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecars = [
  "0104_custom_fields",
  "0105_plugin_runtime",
  "0106_theme_document_v6",
  "0107_plugin_platform",
  "0108_customer_marketing",
  "0109_inventory_purchasing",
  "0110_plugin_providers",
  "0111_order_money_chain",
  "0112_markets",
  "0113_country_aware_addresses",
  "0114_shipping_zones",
  "0115_selling_countries_dependency",
  "0116_tax_regions",
  "0117_phoneless_guest_customers",
  "0118_places",
  "0119_billing_addresses",
  "0120_price_lists",
  "0121_translations",
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_pg_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(schemaSql);
  openClients.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function applySidecar(client: Client, file: string): Promise<void> {
  const sql = readFileSync(file, "utf8");
  await client.query("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe.runIf(postgresUrl)("0121 translations PostgreSQL sidecar", () => {
  it("adds store languages, translations and localized handles with their guards and cache keys", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
      INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en');
      INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
        VALUES ('cl_bn', 'Bangla', 'bn', 1, 0, '{}', '{}'), ('cl_fr', 'French', 'fr', 0, 0, '{}', '{}');
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_tee', 'Tee', 50000, 'tee', 1), ('p_cap', 'Cap', 20000, 'cap', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1);
    `);
    await applySidecar(client, sidecars.at(-1)!);

    const languages = await client.query("SELECT locale, published FROM store_languages ORDER BY locale");
    expect(languages.rows).toEqual([{ locale: "bn", published: "1" }, { locale: "en", published: "1" }, { locale: "fr", published: "0" }]);
    expect((await client.query("SELECT locale FROM market_presences WHERE value = ''")).rows).toEqual([{ locale: "bn" }]);
    await expect(client.query("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_de', 'mkt_in', 'subfolder', 'de-in', 'de')")).rejects.toThrow(/STORE_LANGUAGE_REQUIRED/);
    await expect(client.query("UPDATE store_languages SET published = 0 WHERE locale = 'bn'")).rejects.toThrow(/STORE_LANGUAGE_DEFAULT_REQUIRED/);
    await expect(client.query("DELETE FROM store_languages WHERE locale = 'en'")).rejects.toThrow(/STORE_LANGUAGE_IN_USE/);

    await expect(client.query("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'cap', 'p_tee')")).rejects.toThrow(/LOCALIZED_SLUG_TAKEN/);
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    const start = { product: await seq("tr:product:p_tee"), slugs: await seq("tr:slugs:product:bn") };
    await client.query("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti', 'p_tee')");
    expect(await seq("tr:slugs:product:bn")).toBeGreaterThan(start.slugs);
    await expect(client.query("UPDATE products SET slug = 'ti' WHERE id = 'p_cap'")).rejects.toThrow(/LOCALIZED_SLUG_TAKEN/);
    const afterSlug = await seq("tr:product:p_tee");
    expect(afterSlug).toBeGreaterThan(start.product);
    await client.query("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_sku01', 'product_variant', 'v_tee', 'bn', '{\"preorderMessage\":\"x\"}')");
    expect(await seq("tr:product:p_tee")).toBeGreaterThan(afterSlug);
    await expect(client.query("INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_sku02', 'product_variant', 'v_tee', 'bn', '{}')")).rejects.toThrow(/translations_identity_unique/);
    const locales = await seq("tr:locales");
    await client.query("UPDATE store_languages SET published = 1 WHERE locale = 'fr'");
    expect(await seq("tr:locales")).toBeGreaterThan(locales);

    await client.query("DELETE FROM products WHERE id = 'p_tee'");
    expect((await client.query("SELECT count(*) AS n FROM translations")).rows[0].n).toBe("0");
    expect((await client.query("SELECT count(*) AS n FROM localized_slugs")).rows[0].n).toBe("0");

    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 121");
    expect(ledger.rows[0]?.name).toBe("0121_translations");
  });
});
