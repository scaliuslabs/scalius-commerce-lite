import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { createSqliteD1Binding } from "@scalius/database/testing/sqlite-d1";
import { safeBatch } from "@scalius/database/client";
import { encodeIndexTuple } from "./index-encoding";
import type { Database } from "@scalius/database/client";
import { objectTypeId } from "@scalius/shared/plugins/objects";
import { withDependencyScope } from "../../cache-deps";
import { listPublicObjects, planStorefrontObjects } from "./storefront";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE object_types (id TEXT PRIMARY KEY, namespace TEXT, type TEXT, name TEXT, fields_json TEXT, display_field TEXT, storefront INTEGER, indexes_json TEXT DEFAULT '[]');
    CREATE TABLE object_records (type_id TEXT, id TEXT, handle TEXT, data_json TEXT, position INTEGER, pub INTEGER, status TEXT, k1 TEXT, k2 TEXT, k3 TEXT, k4 TEXT);
    CREATE TABLE settings (category TEXT, key TEXT, value TEXT);
  `);
  const db = drizzle(createSqliteD1Binding(sqlite)) as unknown as Database;
  const type = (name: string, storefront = 1, fields: unknown[] = [{ key: "title", name: "Title", type: "single_line_text" }]) => {
    sqlite.prepare("INSERT INTO object_types (id, namespace, type, name, fields_json, display_field, storefront) VALUES (?, 'custom', ?, ?, ?, 'title', ?)").run(objectTypeId("custom", name), name, name, JSON.stringify(fields), storefront);
  };
  const record = (typeName: string, id: string, pub = 1, data: Record<string, unknown> = { title: id }, position = 0) => {
    sqlite.prepare("INSERT INTO object_records (type_id, id, handle, data_json, position, pub, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(objectTypeId("custom", typeName), id, id, JSON.stringify(data), position, pub, pub ? "published" : "draft");
  };
  return { db, sqlite, type, record };
}

describe("public Objects projection", () => {
  it("uses no statements for unused objects and at most four bounded type reads", () => {
    const { db, sqlite } = fixture();
    expect(planStorefrontObjects(db, []).statements).toHaveLength(0);
    expect(planStorefrontObjects(db, Array.from({ length: 8 }, (_, i) => ({ typeId: `oty_custom.t${i}`, limit: 100 }))).statements).toHaveLength(4);
    sqlite.close();
  });

  it("shares public sections and bindings, excludes private/draft records, and filters handles before the bound", async () => {
    const { db, sqlite, type, record } = fixture();
    type("testimonials"); type("private", 0);
    for (let i = 0; i < 30; i++) record("testimonials", `record-${i}`, 1, { title: `Customer ${i}` }, i);
    record("testimonials", "draft", 0); record("private", "secret");
    expect((await listPublicObjects(db, "custom.testimonials"))?.records).toHaveLength(24);
    expect((await listPublicObjects(db, "custom.testimonials", { handle: "record-29" }))?.records).toEqual([{ id: "record-29", handle: "record-29", data: { title: "Customer 29" } }]);
    expect(await listPublicObjects(db, "custom.private")).toBeNull();
    expect(await listPublicObjects(db, "custom.missing")).toBeNull();
    expect((await listPublicObjects(db, "custom.testimonials", { handle: "draft" }))?.records).toEqual([]);
    sqlite.close();
  });


  it("filters indexed fields before the limit and prioritizes bound handles", async () => {
    const { db, sqlite, type, record } = fixture();
    type("testimonials");
    sqlite.exec(`UPDATE object_types SET indexes_json = '["title"]'`);
    for (let i = 0; i < 30; i++) record("testimonials", `record-${i}`, 1, { title: `Title ${i}` }, i);
    sqlite.prepare("UPDATE object_records SET k1 = ? WHERE id = 'record-29'").run(encodeIndexTuple(["Title 29"], ["title"]));
    const filtered = planStorefrontObjects(db, [{ typeId: objectTypeId("custom", "testimonials"), limit: 1, where: { title: "Title 29" } }]);
    expect(filtered.resolve(await safeBatch(db, filtered.statements), 0).bindingObjects["custom.testimonials"]?.records[0]?.id).toBe("record-29");
    const unknown = planStorefrontObjects(db, [{ typeId: objectTypeId("custom", "testimonials"), limit: 1, where: { absent: "Title 29" } }]);
    expect(unknown.resolve(await safeBatch(db, unknown.statements), 0).bindingObjects["custom.testimonials"]?.records).toEqual([]);
    const bound = planStorefrontObjects(db, [{ typeId: objectTypeId("custom", "testimonials"), limit: 24, handles: ["record-29"] }]);
    expect(bound.resolve(await safeBatch(db, bound.statements), 0).bindingObjects["custom.testimonials"]?.records[0]?.id).toBe("record-29");
    sqlite.close();
  });

  it("omits private references, resolves public weak object references and declares exact type dependencies", async () => {
    const { db, sqlite, type, record } = fixture();
    type("targets");
    type("source", 1, [
      { key: "title", name: "Title", type: "single_line_text" },
      { key: "buyer", name: "Buyer", type: "customer_reference" },
      { key: "order", name: "Order", type: "order_reference" },
      { key: "related", name: "Related", type: "list.object_reference", to: "custom.targets" },
      { key: "missing", name: "Missing", type: "object_reference", to: "custom.targets" },
      { key: "price", name: "Price", type: "money" },
    ]);
    record("targets", "public"); record("targets", "draft", 0);
    record("source", "hello", 1, { title: "Hello", buyer: "customer_secret", order: "order_secret", related: ["public", "draft", "deleted"], missing: "deleted", price: 12300 });
    const { value, dependencies } = await withDependencyScope(() => listPublicObjects(db, "custom.source"), { strict: true });
    expect(value?.records[0]?.data).toEqual({ title: "Hello", related: ["public", null, null], missing: null, price: 123 });
    expect(dependencies.keys).toContain("obj:oty_custom.source");
    expect(dependencies.keys).toContain("obj:oty_custom.targets");
    expect(dependencies.coarseTables).toEqual([]);
    sqlite.close();
  });
});
