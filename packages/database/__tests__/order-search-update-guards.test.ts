import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const readMigration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
const migration = readMigration("0157_order_search_update_guards");

// Use the deployed FTS5 table and triggers on an isolated order row: its exact
// write count excludes unrelated order projections and directly measures FTS.
function legacyOrderSearch() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, customer_name TEXT, customer_phone TEXT, customer_email TEXT,
    status TEXT DEFAULT 'pending', inventory_action TEXT DEFAULT 'none'
  );
  CREATE TABLE scalius_schema_migrations (version INTEGER PRIMARY KEY, name TEXT, source_sha256 TEXT);`);
  const table = splitSchemaMigrationStatements(readMigration("0000_blushing_jack_power"))
    .find((statement) => statement.startsWith("CREATE VIRTUAL TABLE orders_fts "));
  if (!table) throw new Error("Missing deployed order FTS5 table");
  db.exec(table);
  for (const trigger of splitSchemaMigrationStatements(readMigration("0065_single_checkout_commit"))
    .filter((statement) => statement.startsWith("CREATE TRIGGER `orders_fts_"))) db.exec(trigger);
  db.exec(`INSERT INTO orders (id, customer_name, customer_phone)
    VALUES ('orderalpha', 'Namealpha', '1711111111')`);
  return db;
}

describe("0157 order search update guards", () => {
  it("preserves the index and performs only the row write for operational or unchanged-field updates", () => {
    const db = legacyOrderSearch();
    try {
      const search = () => db.prepare("SELECT rowid FROM orders_fts WHERE orders_fts MATCH 'Namealpha'").all();
      const before = search();
      expect(before).toHaveLength(1);
      db.exec(`BEGIN; ${migration} COMMIT;`);
      expect(search()).toEqual(before);
      const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
      for (let i = 0; i < 20; i++) {
        const beforeWrite = changes();
        db.prepare("UPDATE orders SET status = ?, inventory_action = ? WHERE id = 'orderalpha'")
          .run(i % 2 ? "pending" : "confirmed", i % 2 ? "released" : "reserved");
        expect(changes() - beforeWrite).toBe(1);
      }
      const beforeNoop = changes();
      db.exec(`UPDATE orders SET id = id, customer_name = customer_name,
        customer_phone = customer_phone, customer_email = customer_email`);
      expect(changes() - beforeNoop).toBe(1);
      expect(search()).toEqual(before);
    } finally { db.close(); }
  });

  it("removes old terms and indexes every changed field, null transition and row identity", () => {
    const db = legacyOrderSearch();
    try {
      db.exec(`BEGIN; ${migration} COMMIT;`);
      const matches = (query: string) => db.prepare("SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?").all(query);
      const row = () => db.prepare("SELECT rowid FROM orders").all();
      for (const [column, oldValue, nextValue, indexedColumn] of [
        ["customer_name", "Namealpha", "Namebeta", "customer_name"],
        ["customer_phone", "1711111111", "1822222222", "customer_phone"],
        ["id", "orderalpha", "orderbeta", "order_id"],
      ] as const) {
        db.prepare(`UPDATE orders SET ${column} = ?`).run(nextValue);
        expect(matches(`${indexedColumn}:${oldValue}`)).toEqual([]);
        expect(matches(`${indexedColumn}:${nextValue}`)).toEqual(row());
      }
      db.exec("UPDATE orders SET customer_email = 'first@example.test'");
      expect(matches("customer_email:first")).toEqual(row());
      db.exec("UPDATE orders SET customer_email = NULL");
      expect(matches("customer_email:first")).toEqual([]);
      db.exec("UPDATE orders SET rowid = 42");
      expect(matches("Namebeta")).toEqual([{ rowid: 42 }]);
      db.exec("DELETE FROM orders");
      expect(matches("Namebeta")).toEqual([]);
    } finally { db.close(); }
  });

  it("keeps providers without FTS5 on their existing guarded search index", () => {
    const ledger = splitSchemaMigrationStatements(migration).at(-1);
    expect(splitSchemaMigrationStatements(compileSqliteMigrationForProvider(migration, "turso"))).toEqual([ledger]);
    expect(splitSchemaMigrationStatements(readMigration("postgres/0157_order_search_update_guards"))).toEqual([ledger]);
  });
});
