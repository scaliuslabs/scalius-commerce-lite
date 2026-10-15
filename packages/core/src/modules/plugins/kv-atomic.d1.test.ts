import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { compareAndSetPluginKv, getPluginKvVersion, setPluginKv } from "./kv";

const PLUGIN = "acme.loyalty";
let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => { ({ sqlite, db } = createSqliteD1Database()); });
afterEach(() => sqlite.close());

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
