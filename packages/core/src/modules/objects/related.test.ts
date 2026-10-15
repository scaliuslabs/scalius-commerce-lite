import { DatabaseSync } from "node:sqlite";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { encodeIndexTuple } from "./index-encoding";
import { parseRelatedObjects, relatedObjectsJson } from "./related";

describe("related object projection", () => {
  it("uses bounded index reads, deduplicates references and hides private types", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE object_types (id TEXT PRIMARY KEY, namespace TEXT, type TEXT, name TEXT, fields_json TEXT, indexes_json TEXT, display_field TEXT, admin TEXT);
        CREATE TABLE object_records (type_id TEXT, id TEXT, data_json TEXT, handle TEXT, k1 TEXT, k2 TEXT, k3 TEXT, k4 TEXT, PRIMARY KEY(type_id,id));
        CREATE INDEX object_k1 ON object_records(type_id,k1,id) WHERE k1 IS NOT NULL;
        CREATE INDEX object_k2 ON object_records(type_id,k2,id) WHERE k2 IS NOT NULL;
        CREATE INDEX object_k3 ON object_records(type_id,k3,id) WHERE k3 IS NOT NULL;
        CREATE INDEX object_k4 ON object_records(type_id,k4,id) WHERE k4 IS NOT NULL;
      `);
      const type = db.prepare("INSERT INTO object_types VALUES (?, 'custom', ?, 'Recommendations', ?, ?, 'name', ?)");
      const fields = JSON.stringify([{ key: "product", type: "product_reference" }, { key: "customer", type: "customer_reference" }]);
      const indexes = JSON.stringify(["product", ["product", "rank"], "customer"]);
      type.run("oty_custom.visible", "visible", fields, indexes, "edit");
      type.run("oty_custom.hidden", "hidden", fields, indexes, "none");
      const insert = db.prepare("INSERT INTO object_records VALUES (?,?,?,NULL,?,?,?,NULL)");
      const product = encodeIndexTuple(["prod_1"], ["product"]);
      const compound = encodeIndexTuple(["prod_1", 5], ["product", "rank"]);
      const customer = encodeIndexTuple(["cus_1"], ["customer"]);
      insert.run("oty_custom.visible", "both", '{"name":"Both references"}', product, compound, customer);
      insert.run("oty_custom.visible", "compound", '{"name":"Compound reference"}', null, compound, null);
      insert.run("oty_custom.hidden", "private", '{"name":"Private"}', product, compound, customer);
      const query = new SQLiteSyncDialect().sqlToQuery(relatedObjectsJson("product", "prod_1"));
      const execute = () => parseRelatedObjects(db.prepare(`SELECT ${query.sql} AS related`).get(...query.params as string[])?.related as string | null);
      expect(execute().map((record) => record.recordId).sort()).toEqual(["both", "compound"]);
      expect(execute()[0]).toMatchObject({ typeHandle: "custom.visible", typeName: "Recommendations" });
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ${query.sql}`).all(...query.params as string[]) as Array<{ detail: string }>;
      expect(plan.filter((row) => /SCAN related_record/.test(row.detail))).toEqual([]);
      expect(plan.filter((row) => /SEARCH related_record USING INDEX object_k/.test(row.detail))).toHaveLength(4);
      for (let i = 0; i < 30; i++) insert.run("oty_custom.visible", `more_${i}`, '{}', product, null, null);
      expect(execute()).toHaveLength(25);
      const empty = new SQLiteSyncDialect().sqlToQuery(relatedObjectsJson("order", "ord_1"));
      expect(parseRelatedObjects(db.prepare(`SELECT ${empty.sql} AS related`).get(...empty.params as string[])?.related as string | null)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
