import { describe, expect, it } from "vitest";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

describe.each(["d1", "turso"] as const)("0156 custom-field references on %s", (provider) => {
  it("preserves values, indexes, foreign keys and triggers while expanding the type constraint", () => {
    const db = createMigratedSqlite({ provider, beforeMigration: "0156_" });
    try {
      db.exec(`
        INSERT INTO products (id, name, slug) VALUES ('cf_owner', 'Fixture', 'cf-owner');
        INSERT INTO custom_field_definitions
          (id, owner_type, namespace, key, name, description, type, validations, storefront_visible, position, revision, created_at, updated_at)
          VALUES ('cfd_fixture', 'product', 'custom', 'care', 'Care', 'Preserved description', 'single_line_text', '{"max":80}', 1, 4, 7, 100, 200);
        INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value, updated_at)
          VALUES ('cfd_fixture', 'product', 'cf_owner', 'Keep this value', 300);
      `);
      const definitions = db.prepare("SELECT * FROM custom_field_definitions ORDER BY id").all();
      const values = db.prepare("SELECT * FROM custom_field_values ORDER BY definition_id, owner_id").all();
      const schemaObjects = () => db.prepare(`SELECT type, name, sql FROM sqlite_master
        WHERE (type = 'index' AND tbl_name IN ('custom_field_definitions', 'custom_field_values'))
          OR (type = 'trigger' AND (tbl_name IN ('custom_field_definitions', 'custom_field_values') OR substr(name, 1, 4) = 'cfv_'))
        ORDER BY type, name`).all();
      const beforeObjects = schemaObjects();
      db.exec(`BEGIN; ${compiledMigrationSql(provider, "0157_", "0156_")} COMMIT;`);
      expect(db.prepare("SELECT * FROM custom_field_definitions ORDER BY id").all()).toEqual(definitions);
      expect(db.prepare("SELECT * FROM custom_field_values ORDER BY definition_id, owner_id").all()).toEqual(values);
      expect(schemaObjects()).toEqual(beforeObjects);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      const insert = db.prepare(`INSERT INTO custom_field_definitions
        (id, owner_type, namespace, key, name, type, validations)
        VALUES (?, 'product', 'custom', ?, 'Reference', ?, '{"to":"custom.size_chart"}')`);
      insert.run("cfd_object_ref", "chart", "object_reference");
      insert.run("cfd_object_refs", "charts", "list.object_reference");
      expect(() => insert.run("cfd_invalid", "invalid", "unknown_reference")).toThrow(/CHECK constraint/);
      expect(() => db.exec(`INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value)
        VALUES ('cfd_fixture', 'order', 'wrong_owner', 'Invalid')`)).toThrow(/FOREIGN KEY/);
      expect(() => insert.run("cfd_duplicate", "care", "object_reference")).toThrow(/UNIQUE constraint/);

      db.exec("DELETE FROM cache_dep WHERE dep = 'p:cf_owner'");
      db.exec("UPDATE custom_field_values SET value = 'Changed' WHERE definition_id = 'cfd_fixture'");
      expect(db.prepare("SELECT dep FROM cache_dep WHERE dep = 'p:cf_owner'").get()).toEqual({ dep: "p:cf_owner" });
      db.exec("DELETE FROM products WHERE id = 'cf_owner'");
      expect(db.prepare("SELECT * FROM custom_field_values").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE substr(name, 1, 5) = '__cf_'").all()).toEqual([]);
    } finally { db.close(); }
  });
});
