// Conditional plugin storage on the real migrated schema (D1 semantics):
// revisions, compare-and-set puts and deletes, all-or-nothing batches across
// collections, and KV compare-and-set. The SDK's update and increment loops
// over these are proven through both loaders (apps/api plugin suites).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  compareAndSetPluginKv,
  deletePluginRecord,
  getPluginKvVersion,
  getPluginRecord,
  getPluginRecordVersion,
  putPluginRecord,
  setPluginKv,
  writePluginRecords,
  type PluginCollectionDeclaration,
} from "./index";

const PLUGIN = "acme.loyalty";
const BALANCES: PluginCollectionDeclaration = { indexes: [], unique: [] };
const LEDGER: PluginCollectionDeclaration = { indexes: ["customerId"], unique: ["ref"] };
const collections = (name: string) => (name === "ledger" ? LEDGER : BALANCES);

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
});
afterEach(() => sqlite.close());

describe("conditional records", () => {
  it("advances a revision on every write and writes only at the revision read", async () => {
    expect(await putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 10 }, null)).toEqual({ revision: 1 });
    await expect(putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 99 }, null))
      .rejects.toMatchObject({ pluginCode: "storage.conflict" });
    expect(await putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 20 }, 1)).toEqual({ revision: 2 });
    await expect(putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 30 }, 1))
      .rejects.toMatchObject({ pluginCode: "storage.conflict" });
    // Unconditional writes still work, and advance the revision too.
    expect(await putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 40 })).toEqual({ revision: 3 });
    expect(await getPluginRecordVersion(db, PLUGIN, "balances", "c1")).toEqual({ data: { points: 40 }, revision: 3 });

    await expect(deletePluginRecord(db, PLUGIN, "balances", "c1", 2)).rejects.toMatchObject({ pluginCode: "storage.conflict" });
    expect(await deletePluginRecord(db, PLUGIN, "balances", "c1", 3)).toBe(true);
    expect(await getPluginRecord(db, PLUGIN, "balances", "c1")).toBeNull();
  });

  it("commits a batch across collections all-or-nothing and names the failed condition", async () => {
    await putPluginRecord(db, PLUGIN, "balances", BALANCES, "c1", { points: 100 });
    const revisions = await writePluginRecords(db, PLUGIN, collections, [
      { op: "put", collection: "balances", id: "c1", record: { points: 60 }, expectedRevision: 1 },
      { op: "put", collection: "ledger", id: "evt-1", record: { customerId: "c1", ref: "o1", points: -40 }, expectedRevision: null },
      { op: "check", collection: "balances", id: "c2", expectedRevision: null },
    ]);
    expect(revisions).toEqual([2, 1, null]);

    // The second operation's condition fails: the first write is not applied either.
    await expect(writePluginRecords(db, PLUGIN, collections, [
      { op: "put", collection: "balances", id: "c1", record: { points: 20 }, expectedRevision: 2 },
      { op: "put", collection: "ledger", id: "evt-1", record: { customerId: "c1", ref: "o1-again", points: -40 }, expectedRevision: null },
    ])).rejects.toMatchObject({ pluginCode: "storage.conflict", details: { index: 1 } });
    expect(await getPluginRecordVersion(db, PLUGIN, "balances", "c1")).toEqual({ data: { points: 60 }, revision: 2 });

    // A unique index violation aborts the batch the same way.
    await expect(writePluginRecords(db, PLUGIN, collections, [
      { op: "put", collection: "balances", id: "c1", record: { points: 0 } },
      { op: "put", collection: "ledger", id: "evt-2", record: { customerId: "c1", ref: "o1" } },
    ])).rejects.toMatchObject({ pluginCode: "storage.unique_violation" });
    expect((await getPluginRecord(db, PLUGIN, "balances", "c1"))?.points).toBe(60);
  });

  it("refuses malformed and oversized batches before writing", async () => {
    await expect(writePluginRecords(db, PLUGIN, collections, [])).rejects.toMatchObject({ pluginCode: "storage.invalid_batch" });
    await expect(writePluginRecords(db, PLUGIN, collections, Array.from({ length: 26 }, (_, index) => ({
      op: "put" as const, collection: "balances", id: `c${index}`, record: {},
    })))).rejects.toMatchObject({ pluginCode: "storage.invalid_batch" });
    await expect(writePluginRecords(db, PLUGIN, collections, [
      { op: "put", collection: "balances", id: "c1", record: {} },
      { op: "delete", collection: "balances", id: "c1" },
    ])).rejects.toMatchObject({ pluginCode: "storage.invalid_batch" });
    await expect(writePluginRecords(db, PLUGIN, collections, [
      { op: "put", collection: "balances", id: "c1", record: {}, expectedRevision: 0 },
    ])).rejects.toMatchObject({ pluginCode: "storage.invalid_batch" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_records").get()).toEqual({ n: 0 });
  });
});

describe("kv compare-and-set", () => {
  it("writes only at the revision read, treating an expired entry as absent", async () => {
    expect(await compareAndSetPluginKv(db, PLUGIN, "lock", null, { owner: "a" })).toEqual({ revision: 1 });
    await expect(compareAndSetPluginKv(db, PLUGIN, "lock", null, { owner: "b" })).rejects.toMatchObject({ pluginCode: "kv.conflict" });
    expect(await compareAndSetPluginKv(db, PLUGIN, "lock", 1, { owner: "b" }, { ttlSeconds: 60 })).toEqual({ revision: 2 });
    expect(await getPluginKvVersion(db, PLUGIN, "lock")).toEqual({ value: { owner: "b" }, revision: 2 });
    expect(await setPluginKv(db, PLUGIN, "lock", { owner: "c" }, { ttlSeconds: 60 })).toEqual({ revision: 3 });

    sqlite.prepare("UPDATE plugin_kv SET expires_at = unixepoch() - 1 WHERE key = 'lock'").run();
    expect(await getPluginKvVersion(db, PLUGIN, "lock")).toBeNull();
    await expect(compareAndSetPluginKv(db, PLUGIN, "lock", 3, { owner: "d" })).rejects.toMatchObject({ pluginCode: "kv.conflict" });
    expect(await compareAndSetPluginKv(db, PLUGIN, "lock", null, { owner: "d" })).toEqual({ revision: 4 });
    await expect(compareAndSetPluginKv(db, PLUGIN, "lock", 0, "x")).rejects.toMatchObject({ pluginCode: "kv.invalid_revision" });
  });
});
