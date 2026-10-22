// An app's data lifecycle on the real migrated schema (D1 semantics): an
// uninstall that keeps data keeps the app's name and settings too, lists its
// data as a removed app's and gives it all back on a reinstall from the same
// developer (another developer's release is refused until the data is
// deleted); an uninstall that deletes data deletes every kind
// it owns; data an app left without any record of its removal (an old
// uninstall, a bundled app taken out of the deployment) is listed under its
// id; "Delete data" deletes one removed app's group under its revision and
// never while the app is installed, advancing the cache dependency of a
// content type the online store showed.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { objectTypeDeclarationSchema, objectTypeId } from "@scalius/shared/plugins/objects";
import { writeObjectRecords } from "../objects";
import {
  PluginError,
  deleteRemovedAppData,
  handOverRemovedAppData,
  describePluginSettings,
  installPlugin,
  listRemovedAppData,
  readPluginRuntimeSettings,
  requirePluginInstallation,
  setPluginKv,
  uninstallPlugin,
  writePluginSettings,
} from "./index";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 3)).toString("base64");
const SHA = "e".repeat(64);
const SHELF = objectTypeDeclarationSchema.parse({
  name: "Shelf",
  fields: [{ key: "title", name: "Title", type: "single_line_text" }],
  storefront: true,
  admin: "read",
});

function manifest(id = "acme.bazaar", overrides: Partial<PluginManifestInput> = {}): PluginManifestInput {
  return {
    id,
    name: "Acme Bazaar",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Sellers and shelves.",
    author: { name: "Acme" },
    scopes: ["read_orders"],
    objects: { shelf: SHELF },
    settings: [
      { key: "commission", label: "Commission", type: "number", default: 5, min: 0, max: 50 },
      { key: "api_key", label: "API key", type: "secret" },
    ],
    ...overrides,
  };
}

describe("app data lifecycle", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  const dep = (key: string) => Number((sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0);

  /** Installs the app and gives it one of every kind of data it can own. */
  async function seed(id = "acme.bazaar") {
    await installPlugin(db, { manifest: manifest(id), source: "upload", bundleSha256: SHA });
    await writeObjectRecords(db, id, () => SHELF, [{ op: "put", object: "shelf", id: "s1", record: { title: "Front" }, expectedRevision: null, status: "published" }]);
    await setPluginKv(db, id, "cursor", 7);
    sqlite.prepare("INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES (?, 'product', ?, 'shelf', 'Shelf', 'single_line_text')")
      .run(`cfd_${id.replace(/\W/g, "_")}`, id);
    sqlite.prepare("INSERT INTO plugin_customer_roles (plugin_id, customer_id, role) VALUES (?, 'cus_seller', 'seller')").run(id);
    sqlite.prepare("INSERT INTO bulk_runs (id, kind, status, operation_key, request_hash, input) VALUES (?, 'app.job', 'done', ?, 'h', '{}')")
      .run(`blk_${id.replace(/\W/g, "_")}`, `app:${id}:import:1`);
    sqlite.prepare("INSERT INTO app_resource_owners (resource_type, resource_id, plugin_id) VALUES ('brand', ?, ?)").run(`brd_${id.replace(/\W/g, "_")}`, id);
    return requirePluginInstallation(db, id);
  }

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO customers (id, name, phone) VALUES ('cus_seller', 'Seller', '+8801711111111')").run();
  });
  afterEach(() => sqlite.close());

  it("keeps data, name and settings on uninstall, lists them as a removed app's and gives them back on reinstall", async () => {
    const installed = await seed();
    const configured = await writePluginSettings(db, "acme.bazaar", { commission: 12, api_key: "sk-real-0123456789" }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: KEY,
    });
    await uninstallPlugin(db, "acme.bazaar", { keepData: true, expectedRevision: configured.revision });

    const [removed, ...others] = await listRemovedAppData(db);
    expect(others).toEqual([]);
    expect(removed).toMatchObject({
      pluginId: "acme.bazaar",
      name: "Acme Bazaar",
      revision: 1,
      objectTypes: 1,
      records: 1,
      objectTypeHandles: ["acme.bazaar.shelf"],
      customFields: 1,
      keyValues: 1,
      customerRoles: 1,
      jobs: 1,
      catalogItems: 1,
      settings: true,
    });
    expect(removed!.removedAt).toBeGreaterThan(0);

    // A reinstall from the same developer takes everything back, its secret included.
    const reinstalled = await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA });
    expect(describePluginSettings(reinstalled).values).toMatchObject({ commission: 12 });
    expect((await readPluginRuntimeSettings(reinstalled, KEY)).values).toMatchObject({ api_key: "sk-real-0123456789" });
    expect(await listRemovedAppData(db)).toEqual([]);
    expect(count("SELECT count(*) AS n FROM system_kv WHERE key = 'plugin-retained:acme.bazaar'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM object_records")).toBe(1);

    // Security audit N4: another developer's release under this id never
    // inherits the data. It is refused while the data is kept; the data
    // stays listed and untouched, and once deleted the release starts clean.
    await uninstallPlugin(db, "acme.bazaar", { keepData: true, expectedRevision: reinstalled.revision });
    expect((await listRemovedAppData(db))[0]!.revision).toBe(1);
    await expect(installPlugin(db, { manifest: manifest(), source: "registry", bundleSha256: SHA, signerKeyId: "key_other" }))
      .rejects.toMatchObject({ pluginCode: "retained_data_other_developer", status: 409 });
    expect(count("SELECT count(*) AS n FROM plugin_installations")).toBe(0);
    const kept = (await listRemovedAppData(db))[0]!;
    expect(kept).toMatchObject({ pluginId: "acme.bazaar", records: 1, keyValues: 1, catalogItems: 1, settings: true });

    await deleteRemovedAppData(db, "acme.bazaar", kept.revision);
    // Defaults only: nothing of the first developer's settings or data comes back.
    const clean = await installPlugin(db, { manifest: manifest(), source: "registry", bundleSha256: SHA, signerKeyId: "key_other" });
    expect(describePluginSettings(clean)).toMatchObject({ values: { commission: 5 }, secrets: { api_key: false } });
    for (const table of ["plugin_kv", "object_records", "app_resource_owners", "plugin_customer_roles"]) {
      expect(count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
  });

  it("gives kept data back only to the same developer: an unsigned upload never takes a signed app's data", async () => {
    await installPlugin(db, { manifest: manifest(), source: "registry", bundleSha256: SHA, signerKeyId: "key_acme" });
    await setPluginKv(db, "acme.bazaar", "refresh_token", "partner-token");
    const installed = await requirePluginInstallation(db, "acme.bazaar");
    await uninstallPlugin(db, "acme.bazaar", { keepData: true, expectedRevision: installed.revision });

    await expect(installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA }))
      .rejects.toMatchObject({ pluginCode: "retained_data_other_developer" });
    const back = await installPlugin(db, { manifest: manifest(), source: "registry", bundleSha256: SHA, signerKeyId: "key_acme" });
    expect(back.signerKeyId).toBe("key_acme");
    expect(count("SELECT count(*) AS n FROM plugin_kv WHERE plugin_id = 'acme.bazaar'")).toBe(1);
  });

  it("holds a release from another source while data is kept, until a Super Admin hands the data over", async () => {
    // A signed upload keeps data, then the merchant moves the app into the store's own (bundled, unsigned) code.
    await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA, signerKeyId: "1a2b3c4d5e6f7a8b" });
    await setPluginKv(db, "acme.bazaar", "refresh_token", "partner-token");
    const installed = await requirePluginInstallation(db, "acme.bazaar");
    await uninstallPlugin(db, "acme.bazaar", { keepData: true, expectedRevision: installed.revision });

    const held = await installPlugin(db, { manifest: manifest(), source: "bundled", bundleSha256: SHA }).catch((error: unknown) => error);
    expect(held).toMatchObject({ pluginCode: "retained_data_other_developer", details: { pluginId: "acme.bazaar", retainedSigner: "1a2b3c4d5e6f7a8b", releaseSigner: null, retainedRevision: 1 } });
    // The kept data is listed with the key it belongs to.
    const kept = (await listRemovedAppData(db))[0]!;
    expect(kept).toMatchObject({ pluginId: "acme.bazaar", keyValues: 1, signerKeyId: "1a2b3c4d5e6f7a8b", revision: 1 });

    await expect(handOverRemovedAppData(db, "acme.bazaar", { expectedRevision: 0, signerKeyId: null }))
      .rejects.toMatchObject({ pluginCode: "installation_revision_conflict" });
    expect(await handOverRemovedAppData(db, "acme.bazaar", { expectedRevision: 1, signerKeyId: null })).toEqual({ revision: 2 });
    expect((await listRemovedAppData(db))[0]).toMatchObject({ signerKeyId: null, revision: 2, keyValues: 1 });

    // The bundled release now reclaims everything; the old key no longer could.
    const moved = await installPlugin(db, { manifest: manifest(), source: "bundled", bundleSha256: SHA });
    expect(moved).toMatchObject({ source: "bundled", signerKeyId: null });
    expect(count("SELECT count(*) AS n FROM plugin_kv WHERE plugin_id = 'acme.bazaar'")).toBe(1);
    expect(await listRemovedAppData(db)).toEqual([]);
    await expect(handOverRemovedAppData(db, "acme.bazaar", { expectedRevision: 2, signerKeyId: null }))
      .rejects.toMatchObject({ pluginCode: "installation_exists" });
  });

  it("installs another key's release clean when the removed app kept nothing it could read", async () => {
    // Default settings and no records: the record names an owner of nothing.
    await installPlugin(db, { manifest: manifest("acme.plain", { objects: {} }), source: "upload", bundleSha256: SHA, signerKeyId: "1a2b3c4d5e6f7a8b" });
    const installed = await requirePluginInstallation(db, "acme.plain");
    await uninstallPlugin(db, "acme.plain", { keepData: true, expectedRevision: installed.revision });
    expect(count("SELECT count(*) AS n FROM system_kv WHERE key = 'plugin-retained:acme.plain'")).toBe(1);
    expect(await listRemovedAppData(db)).toEqual([]);

    const bundled = await installPlugin(db, { manifest: manifest("acme.plain", { objects: {} }), source: "bundled", bundleSha256: SHA });
    expect(bundled).toMatchObject({ source: "bundled", signerKeyId: null });
    expect(describePluginSettings(bundled)).toMatchObject({ values: { commission: 5 } });
    expect(count("SELECT count(*) AS n FROM system_kv WHERE key = 'plugin-retained:acme.plain'")).toBe(0);
  });

  it("deletes every kind of data the app owns on an uninstall that does not keep it, and no one else's", async () => {
    const installed = await seed();
    await seed("acme.other");
    sqlite.prepare("INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES ('cfd_merchant', 'product', 'custom', 'shelf', 'Shelf', 'single_line_text')").run();
    await uninstallPlugin(db, "acme.bazaar", { keepData: false, expectedRevision: installed.revision });

    const owned = (table: string, column = "plugin_id") => count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = 'acme.bazaar'`);
    expect([
      owned("object_types", "namespace"),
      owned("custom_field_definitions", "namespace"),
      owned("plugin_kv"),
      owned("plugin_customer_roles"),
      owned("app_resource_owners"),
      count("SELECT count(*) AS n FROM bulk_runs WHERE operation_key LIKE 'app:acme.bazaar:%'"),
      count("SELECT count(*) AS n FROM system_kv WHERE key = 'plugin-retained:acme.bazaar'"),
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(count("SELECT count(*) AS n FROM object_records WHERE type_id = 'oty_acme.other.shelf'")).toBe(1);
    expect(count("SELECT count(*) AS n FROM custom_field_definitions")).toBe(2);
    expect(await listRemovedAppData(db)).toEqual([]);
  });

  it("lists data an app left without a record of its removal under its id, and deletes one group under its revision", async () => {
    await seed();
    await seed("acme.other");
    // An old uninstall (or a bundled app taken out of the deployment) removed only the installation row.
    sqlite.prepare("DELETE FROM plugin_installations").run();
    const typeId = objectTypeId("acme.bazaar", "shelf");
    expect(dep(`obj:${typeId}`)).toBeGreaterThan(0);

    const listed = await listRemovedAppData(db);
    expect(listed.map((entry) => [entry.pluginId, entry.name, entry.revision, entry.settings])).toEqual([
      ["acme.bazaar", "acme.bazaar", 0, false],
      ["acme.other", "acme.other", 0, false],
    ]);

    // Installed again, the app owns its data: nothing is deleted.
    const back = await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA });
    await expect(deleteRemovedAppData(db, "acme.bazaar", 0)).rejects.toMatchObject({ pluginCode: "installation_exists" });
    await uninstallPlugin(db, "acme.bazaar", { keepData: true, expectedRevision: back.revision });

    // Removed again since the list was read: the old revision no longer deletes.
    const stale = await deleteRemovedAppData(db, "acme.bazaar", 0).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(PluginError);
    expect(stale).toMatchObject({ pluginCode: "installation_revision_conflict" });
    expect(count(`SELECT count(*) AS n FROM object_records WHERE type_id = '${typeId}'`)).toBe(1);

    const before = dep(`obj:${typeId}`);
    const current = (await listRemovedAppData(db)).find((entry) => entry.pluginId === "acme.bazaar")!;
    await deleteRemovedAppData(db, "acme.bazaar", current.revision);
    expect((await listRemovedAppData(db)).map((entry) => entry.pluginId)).toEqual(["acme.other"]);
    expect(count("SELECT count(*) AS n FROM object_types WHERE namespace = 'acme.bazaar'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM system_kv WHERE key = 'plugin-retained:acme.bazaar'")).toBe(0);
    // The online store showed that content type: its readers see the delete.
    expect(dep(`obj:${typeId}`)).toBeGreaterThan(before);
    // The other app's data and the merchant's stay.
    expect(count("SELECT count(*) AS n FROM object_records WHERE type_id = 'oty_acme.other.shelf'")).toBe(1);
  });
});
