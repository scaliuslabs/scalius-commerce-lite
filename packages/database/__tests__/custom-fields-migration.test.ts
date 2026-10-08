// Migration 0104 (custom fields, COMMERCE-HOOKS H4): the checked-in SQL holds
// every generated cache dependency trigger verbatim (D1/Turso and the
// PostgreSQL sidecar), the CHECK vocabularies equal the shared codec's, a
// definition's values go with it, and a permanently deleted owner takes its
// values while a trashed one keeps them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CUSTOM_FIELD_OWNER_TYPES, CUSTOM_FIELD_TYPES } from "../../shared/src/custom-fields";
import { CACHE_DEP_LATER_TABLES, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { CUSTOM_FIELD_OWNER_TYPE_VALUES, CUSTOM_FIELD_TYPE_VALUES } from "../src/schema/custom-fields";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0104_custom_fields";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe("0104_custom_fields", () => {
  it("installs every generated cache dependency trigger of its tables, verbatim, on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(new Set(triggers.map((trigger) => trigger.table))).toEqual(new Set(["custom_field_definitions", "custom_field_values"]));
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table).sort())
      .toEqual(["custom_field_definitions", "custom_field_values"]);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
    expect(sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
    // Every GLOB became an anchored-free PostgreSQL regex (a leading `*` is an invalid regex there).
    expect(postgres).not.toMatch(/GLOB|~ '\*/);
  });

  it("mirrors the shared owner and type vocabularies in its CHECKs", () => {
    expect([...CUSTOM_FIELD_OWNER_TYPE_VALUES]).toEqual([...CUSTOM_FIELD_OWNER_TYPES]);
    expect([...CUSTOM_FIELD_TYPE_VALUES]).toEqual([...CUSTOM_FIELD_TYPES]);
  });

  it.each(["d1", "turso"] as const)("keeps identities unique and values with their definition on %s", (provider) => {
    const db = createMigratedSqlite({ provider });
    try {
      const define = (id: string, ownerType: string, namespace: string, key: string) => db.prepare(
        "INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES (?, ?, ?, ?, 'Field', 'single_line_text')",
      ).run(id, ownerType, namespace, key);
      define("cfd_product01", "product", "custom", "care_guide");
      // The same key is free in another namespace or owner type, never twice in one.
      define("cfd_plugin001", "product", "acme.hello", "care_guide");
      define("cfd_plugin002", "product", "a-b.c", "care_guide");
      define("cfd_variant01", "variant", "custom", "care_guide");
      expect(() => define("cfd_product02", "product", "custom", "care_guide")).toThrow(/UNIQUE/);
      // A namespace is `custom` or a plugin id (`vendor.name`); keys are snake_case.
      for (const namespace of ["Custom", "a.b.c", ".a", "a.", "A.b", "loyalty", "-a.b", "a.b-", "a-.b", "a.-b", "a_b.c"]) {
        expect(() => define("cfd_badshape1", "product", namespace, "ok_key"), namespace).toThrow(/CHECK/);
      }
      for (const key of ["Care", "9x", "x-y", "x"]) {
        expect(() => define("cfd_badshape1", "product", "custom", key), key).toThrow(/CHECK/);
      }
      db.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_product01', 'product', 'prod_x', 'Hand wash')").run();
      expect(() => db.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_product01', 'product', 'prod_x', 'again')").run())
        .toThrow(/UNIQUE|PRIMARY/);
      expect(() => db.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_product01', 'variant', 'var_x', 'x')").run())
        .toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_product01', 'product', 'prod_y', '')").run())
        .toThrow(/CHECK/);
      db.prepare("DELETE FROM custom_field_definitions WHERE id = 'cfd_product01'").run();
      expect(db.prepare("SELECT count(*) AS n FROM custom_field_values").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("deletes an owner's values with the owner row and keeps them while it is in trash", () => {
    const db = createMigratedSqlite({ provider: "d1" });
    try {
      db.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published');
        INSERT INTO brands (id, name, slug, status) VALUES ('brd_brand001', 'B', 'b', 'published');
        INSERT INTO collections (id, name, presentation, config) VALUES ('col_a', 'C', 'grid', '{}');
        INSERT INTO pages (id, title, slug, content) VALUES ('pg_a', 'P', 'p', 'x');
        INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Buyer', '01711000000');
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
          VALUES ('ord_a', 'Buyer', '01711000000', 'Address', 'city', 'zone', 'pending');
        INSERT INTO products (id, name, price_minor, slug, category_id) VALUES ('prod_a', 'Product', 100, 'product', 'cat_a');
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default) VALUES ('var_a', 'prod_a', 'SKU-A', 100, 0, 1);
      `);
      const owners: Array<[ownerType: string, ownerId: string, table: string]> = [
        ["product", "prod_a", "products"],
        ["variant", "var_a", "product_variants"],
        ["customer", "cus_a", "customers"],
        ["order", "ord_a", "orders"],
        ["category", "cat_a", "categories"],
        ["collection", "col_a", "collections"],
        ["brand", "brd_brand001", "brands"],
        ["page", "pg_a", "pages"],
      ];
      for (const [ownerType, ownerId] of owners) {
        db.prepare("INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES (?, ?, 'custom', 'note', 'Note', 'single_line_text')")
          .run(`cfd_${ownerType}_note`, ownerType);
        db.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES (?, ?, ?, 'kept')")
          .run(`cfd_${ownerType}_note`, ownerType, ownerId);
      }
      const count = (ownerType: string) => (db.prepare("SELECT count(*) AS n FROM custom_field_values WHERE owner_type = ?").get(ownerType) as { n: number }).n;
      // Trash is an update: values stay for a restore.
      db.exec("UPDATE products SET deleted_at = unixepoch() WHERE id = 'prod_a'");
      expect(count("product")).toBe(1);
      // A product's permanent delete cascades to its SKUs, and each takes its values.
      db.exec("DELETE FROM products WHERE id = 'prod_a'");
      expect(count("product")).toBe(0);
      expect(count("variant")).toBe(0);
      for (const [ownerType, ownerId, table] of owners.slice(2)) {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(ownerId);
        expect(count(ownerType), ownerType).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});
