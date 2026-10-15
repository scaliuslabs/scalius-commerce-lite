import { DatabaseSync } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { objectRecords, objectTypes } from "../src/schema";
import { generateCacheDepTriggers } from "../scripts/cache-dep-triggers";

describe("object cache dependencies", () => {
  it("charges private writes nothing and invalidates publication changes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE cache_clock (id INTEGER PRIMARY KEY, seq INTEGER, coarse INTEGER); INSERT INTO cache_clock VALUES (1,0,0); CREATE TABLE cache_dep (dep TEXT PRIMARY KEY, seq INTEGER, changed_at INTEGER)");
      for (const table of [objectTypes, objectRecords]) {
        const config = getTableConfig(table);
        db.exec(`CREATE TABLE ${config.name} (${config.columns.map((column) => `${column.name} ${column.getSQLType()}`).join(",")})`);
      }
      for (const trigger of generateCacheDepTriggers().filter((trigger) => trigger.table === "object_types" || trigger.table === "object_records")) db.exec(trigger.sqlite);
      const changed = (sql: string) => {
        db.exec("DELETE FROM cache_dep");
        db.exec(sql);
        return db.prepare("SELECT dep FROM cache_dep ORDER BY dep").all().map((row) => row.dep);
      };
      expect(changed("INSERT INTO object_types(id,storefront,name) VALUES ('oty_custom.faq',0,'Questions')")).toEqual([]);
      expect(changed("UPDATE object_types SET name='Private questions'")).toEqual([]);
      expect(changed("INSERT INTO object_records(type_id,id,pub,data_json) VALUES ('oty_custom.faq','one',0,'{}')")).toEqual([]);
      expect(changed("UPDATE object_records SET data_json='{\"text\":\"private\"}'")).toEqual([]);
      expect(changed("UPDATE object_types SET storefront=1")).toEqual(["obj:oty_custom.faq", "t:object_types"]);
      expect(changed("UPDATE object_records SET pub=1")).toEqual(["obj:oty_custom.faq", "t:object_records"]);
      expect(changed("UPDATE object_records SET data_json='{\"text\":\"public\"}'")).toEqual(["obj:oty_custom.faq", "t:object_records"]);
      expect(changed("UPDATE object_records SET revision=2, k1='ab', ev=1")).toEqual([]);
      expect(changed("UPDATE object_records SET pub=0")).toEqual(["obj:oty_custom.faq", "t:object_records"]);
      expect(changed("DELETE FROM object_records")).toEqual([]);
      expect(changed("UPDATE object_types SET storefront=0")).toEqual(["obj:oty_custom.faq", "t:object_types"]);
      expect(changed("DELETE FROM object_types")).toEqual([]);
    } finally { db.close(); }
  });
});
