// Conditional objects on the migrated schema: revisions and atomic batches.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { objectTypeDeclarationSchema, objectTypeId, type ObjectTypeDeclaration } from "@scalius/shared/plugins/objects";
import { deleteObjectRecord, getObjectRecord, getObjectRecordVersion, putObjectRecord, queryObjectRecords, writeObjectRecords } from "./records";
import { createObjectType, getObjectType, updateObjectType } from "./types";

const PLUGIN = "acme.loyalty";
const BALANCES = objectTypeDeclarationSchema.parse({ name: "Balances", fields: [{ key: "points", name: "Points", type: "integer" }] });
const LEDGER = objectTypeDeclarationSchema.parse({ name: "Ledger", fields: [
  { key: "customer_id", name: "Customer", type: "single_line_text" },
  { key: "ref", name: "Reference", type: "single_line_text" },
  { key: "points", name: "Points", type: "integer" },
], indexes: ["customer_id"], unique: ["ref"] });
const collections = (name: string): ObjectTypeDeclaration => name === "ledger" ? LEDGER : BALANCES;
let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  for (const [name, declaration] of [["balances", BALANCES], ["ledger", LEDGER]] as const) {
    sqlite.prepare("INSERT INTO object_types (id,namespace,type,name,fields_json,indexes_json,unique_json) VALUES (?,?,?,?,?,?,?)")
      .run(objectTypeId(PLUGIN, name), PLUGIN, name, declaration.name, JSON.stringify(declaration.fields), JSON.stringify(declaration.indexes), JSON.stringify(declaration.unique));
  }
});
afterEach(() => sqlite.close());

describe("conditional records", () => {
  it("rebuilds unique indexes when records exchange the previous slot values", async () => {
    const declaration = objectTypeDeclarationSchema.parse({ name: "Pairs", fields: [
      { key: "x", name: "X", type: "single_line_text" }, { key: "y", name: "Y", type: "single_line_text" },
    ], indexes: ["x"], unique: ["x"] });
    const type = await createObjectType(db, { type: "pairs", ...declaration });
    await putObjectRecord(db, "custom", "pairs", declaration, "one", { x: "a", y: "b" });
    await putObjectRecord(db, "custom", "pairs", declaration, "two", { x: "b", y: "a" });
    const before = sqlite.prepare("SELECT id,data_json,revision,k1,u1 FROM object_records WHERE type_id = ? ORDER BY id").all(type.id);
    const next = { ...declaration, indexes: ["y"], unique: ["y"] };
    expect(await updateObjectType(db, type.id, { ...next, expectedRevision: type.revision })).toMatchObject({ revision: 2, indexes: ["y"], unique: ["y"] });
    const after = sqlite.prepare("SELECT id,data_json,revision,k1,u1 FROM object_records WHERE type_id = ? ORDER BY id").all(type.id);
    expect(after).toEqual([
      { ...before[0], k1: before[1]!.k1, u1: before[1]!.u1 },
      { ...before[1], k1: before[0]!.k1, u1: before[0]!.u1 },
    ]);
    expect((await queryObjectRecords(db, "custom", "pairs", next, { where: { y: "a" } })).records.map((record) => record.id)).toEqual(["two"]);
    await expect(putObjectRecord(db, "custom", "pairs", next, "three", { x: "c", y: "a" })).rejects.toMatchObject({ objectCode: "object.unique_violation" });
  });

  it("rejects duplicate replacement unique keys without changing the type or its records", async () => {
    const declaration = objectTypeDeclarationSchema.parse({ name: "Pairs", fields: [
      { key: "x", name: "X", type: "single_line_text" }, { key: "y", name: "Y", type: "single_line_text" },
    ], indexes: ["x"], unique: ["x"] });
    const type = await createObjectType(db, { type: "pairs", ...declaration });
    await putObjectRecord(db, "custom", "pairs", declaration, "one", { x: "a", y: "same" });
    await putObjectRecord(db, "custom", "pairs", declaration, "two", { x: "b", y: "same" });
    const beforeType = sqlite.prepare("SELECT * FROM object_types WHERE id = ?").get(type.id);
    const beforeRecords = sqlite.prepare("SELECT * FROM object_records WHERE type_id = ? ORDER BY id").all(type.id);
    await expect(updateObjectType(db, type.id, { ...declaration, unique: ["y"], storefront: true, expectedRevision: type.revision }))
      .rejects.toMatchObject({ objectCode: "object.unique_violation" });
    expect(sqlite.prepare("SELECT * FROM object_types WHERE id = ?").get(type.id)).toEqual(beforeType);
    expect(sqlite.prepare("SELECT * FROM object_records WHERE type_id = ? ORDER BY id").all(type.id)).toEqual(beforeRecords);
  });

  it("answers an exact lookup on a unique set without an index slot of its own", async () => {
    await writeObjectRecords(db, PLUGIN, collections, [
      { object: "ledger", op: "put", id: "l1", record: { customer_id: "c1", ref: "R-1", points: 5 } },
      { object: "ledger", op: "put", id: "l2", record: { customer_id: "c1", points: 7 } },
    ]);
    expect((await queryObjectRecords(db, PLUGIN, "ledger", LEDGER, { where: { ref: "R-1" } })).records.map((record) => record.id)).toEqual(["l1"]);
    expect((await queryObjectRecords(db, PLUGIN, "ledger", LEDGER, { where: { ref: "R-2" } })).records).toEqual([]);
    // A record without the unique field is not in its set: a null lookup needs a real index.
    await expect(queryObjectRecords(db, PLUGIN, "ledger", LEDGER, { where: { ref: null } })).rejects.toMatchObject({ objectCode: "object.unindexed_query" });
    await expect(queryObjectRecords(db, PLUGIN, "ledger", LEDGER, { where: { points: 5 } }))
      .rejects.toThrow("declared indexes: customer_id, unique ref");
  });

  it("orders decimal indexes exactly across signs, fractions and values beyond JS integer precision", async () => {
    const declaration = objectTypeDeclarationSchema.parse({ name: "Amounts", fields: [{ key: "amount", name: "Amount", type: "decimal" }], indexes: ["amount"] });
    await createObjectType(db, { type: "amounts", ...declaration });
    const ordered = ["-100", "-60.5", "-60", "-0.001", "0", "0.001", "60", "60.5", "100", "9007199254740992.9", "9007199254740993.1"];
    for (const [index, amount] of [...ordered].reverse().entries()) await putObjectRecord(db, "custom", "amounts", declaration, `r${index}`, { amount });
    const ascending = await queryObjectRecords(db, "custom", "amounts", declaration, { orderBy: { field: "amount" } });
    expect(ascending.records.map((record) => record.data.amount)).toEqual(ordered);
    const descending = await queryObjectRecords(db, "custom", "amounts", declaration, { orderBy: { field: "amount", direction: "desc" } });
    expect(descending.records.map((record) => record.data.amount)).toEqual([...ordered].reverse());
    expect((await queryObjectRecords(db, "custom", "amounts", declaration, { where: { amount: "60.50" } })).records.map((record) => record.data.amount)).toEqual(["60.5"]);
  });

  it("keeps required fields enforced when a published record is overwritten without status", async () => {
    const declaration = objectTypeDeclarationSchema.parse({ name: "Articles", storefront: true, fields: [
      { key: "title", name: "Title", type: "single_line_text", required: true },
    ] });
    await createObjectType(db, { type: "articles", ...declaration }, { kind: "plugin", pluginId: PLUGIN });
    await writeObjectRecords(db, PLUGIN, () => declaration, [{ op: "put", object: "articles", id: "one", record: { title: "Published" }, status: "published" }]);
    await expect(putObjectRecord(db, PLUGIN, "articles", declaration, "one", {})).rejects.toMatchObject({ objectCode: "object.invalid" });
    expect(await getObjectRecordVersion(db, PLUGIN, "articles", "one")).toMatchObject({ data: { title: "Published" }, status: "published", revision: 1 });
  });

  it("updates content type revisions and normalizes existing record status when visibility changes", async () => {
    const declaration = objectTypeDeclarationSchema.parse({ name: "Notes", fields: [{ key: "title", name: "Title", type: "single_line_text" }] });
    const type = await createObjectType(db, { type: "notes", ...declaration });
    await putObjectRecord(db, "custom", "notes", declaration, "one", { title: "Note" });
    const updated = await updateObjectType(db, type.id, { ...declaration, storefront: true, expectedRevision: type.revision });
    expect(updated).toMatchObject({ revision: 2, storefront: true, admin: "edit" });
    expect(await getObjectRecordVersion(db, "custom", "notes", "one")).toMatchObject({ status: "draft" });
    await expect(updateObjectType(db, type.id, { ...declaration, expectedRevision: 1 })).rejects.toMatchObject({ code: "OBJECT_REVISION_CONFLICT" });
    expect((await getObjectType(db, "custom.notes"))?.id).toBe(type.id);
  });

  it("advances a revision on every write and writes only at the revision read", async () => {
    expect(await putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 10 }, null)).toEqual({ revision: 1 });
    await expect(putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 99 }, null))
      .rejects.toMatchObject({ objectCode: "object.conflict" });
    expect(await putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 20 }, 1)).toEqual({ revision: 2 });
    await expect(putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 30 }, 1))
      .rejects.toMatchObject({ objectCode: "object.conflict" });
    // Unconditional writes still work, and advance the revision too.
    expect(await putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 40 })).toEqual({ revision: 3 });
    expect(await getObjectRecordVersion(db, PLUGIN, "balances", "c1")).toEqual({ data: { points: 40 }, revision: 3, handle: null, status: "active" });

    await expect(deleteObjectRecord(db, PLUGIN, "balances", "c1", 2)).rejects.toMatchObject({ objectCode: "object.conflict" });
    expect(await deleteObjectRecord(db, PLUGIN, "balances", "c1", 3)).toBe(true);
    expect(await getObjectRecord(db, PLUGIN, "balances", "c1")).toBeNull();
  });

  it("commits a batch across collections all-or-nothing and names the failed condition", async () => {
    await putObjectRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 100 });
    const revisions = await writeObjectRecords(db, PLUGIN, collections, [
      { op: "put", object: "balances", id: "c1", record: { points: 60 }, expectedRevision: 1 },
      { op: "put", object: "ledger", id: "evt-1", record: { customer_id: "c1", ref: "o1", points: -40 }, expectedRevision: null },
      { op: "check", object: "balances", id: "c2", expectedRevision: null },
    ]);
    expect(revisions).toEqual([2, 1, null]);

    // The second operation's condition fails: the first write is not applied either.
    await expect(writeObjectRecords(db, PLUGIN, collections, [
      { op: "put", object: "balances", id: "c1", record: { points: 20 }, expectedRevision: 2 },
      { op: "put", object: "ledger", id: "evt-1", record: { customer_id: "c1", ref: "o1-again", points: -40 }, expectedRevision: null },
    ])).rejects.toMatchObject({ objectCode: "object.conflict", details: { index: 1 } });
    expect(await getObjectRecordVersion(db, PLUGIN, "balances", "c1")).toEqual({ data: { points: 60 }, revision: 2, handle: null, status: "active" });

    // A unique index violation aborts the batch the same way.
    await expect(writeObjectRecords(db, PLUGIN, collections, [
      { op: "put", object: "balances", id: "c1", record: { points: 0 } },
      { op: "put", object: "ledger", id: "evt-2", record: { customer_id: "c1", ref: "o1" } },
    ])).rejects.toMatchObject({ objectCode: "object.unique_violation" });
    expect((await getObjectRecord(db, PLUGIN, "balances", "c1"))?.points).toBe(60);
  });

  it("refuses malformed and oversized batches before writing", async () => {
    await expect(writeObjectRecords(db, PLUGIN, collections, [])).rejects.toMatchObject({ objectCode: "object.invalid_batch" });
    await expect(writeObjectRecords(db, PLUGIN, collections, Array.from({ length: 26 }, (_, index) => ({
      op: "put" as const, object: "balances", id: `c${index}`, record: {},
    })))).rejects.toMatchObject({ objectCode: "object.invalid_batch" });
    await expect(writeObjectRecords(db, PLUGIN, collections, [
      { op: "put", object: "balances", id: "c1", record: {} },
      { op: "delete", object: "balances", id: "c1" },
    ])).rejects.toMatchObject({ objectCode: "object.invalid_batch" });
    await expect(writeObjectRecords(db, PLUGIN, collections, [
      { op: "put", object: "balances", id: "c1", record: {}, expectedRevision: 0 },
    ])).rejects.toMatchObject({ objectCode: "object.invalid_batch" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_records").get()).toEqual({ n: 0 });
  });
});
