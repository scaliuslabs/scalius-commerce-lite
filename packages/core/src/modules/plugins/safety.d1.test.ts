// The app safety layer on the real migrated schema (D1 semantics): the
// emergency stop of one app and of every third-party app, limit breaches that
// stop an app when they repeat, the data-update ledger across keep-data and
// delete-data uninstalls, storage measurement, and putting back a release.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { objectTypeDeclarationSchema } from "@scalius/shared/plugins/objects";
import { getObjectRecord, putObjectRecord } from "../objects";
import {
  activatePlugin,
  installPlugin,
  listPluginLogs,
  listPluginMigrations,
  measureDuePluginStorageStatement,
  measurePluginStorage,
  pendingPluginMigrations,
  pluginDueForStorageMeasurement,
  recordPluginBreach,
  recordPluginMigration,
  requirePluginInstallation,
  restorePluginRelease,
  setPluginKv,
  stopPlugin,
  isThirdPartyPlugin,
  stopThirdPartyPlugins,
  uninstallPlugin,
  updatePluginInstallation,
} from "./index";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const LEDGER = objectTypeDeclarationSchema.parse({
  name: "Ledger",
  fields: [
    { key: "customer_id", name: "Customer", type: "single_line_text" },
    { key: "note", name: "Note", type: "single_line_text" },
  ],
  indexes: ["customer_id"],
});

function manifest(overrides: Partial<PluginManifestInput> = {}): PluginManifestInput {
  return {
    id: "acme.loyalty",
    name: "Acme Loyalty",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Points for orders.",
    author: { name: "Acme" },
    scopes: ["read_orders"],
    objects: { ledger: LEDGER },
    ...overrides,
  };
}

async function installActive(db: Database, overrides: Partial<PluginManifestInput> = {}, source: "upload" | "bundled" = "upload") {
  const installed = await installPlugin(db, { manifest: manifest(overrides), source, bundleSha256: SHA });
  return activatePlugin(db, installed.pluginId, { actorUserId: "owner", expectedRevision: installed.revision });
}

describe("app safety", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it("stops one app at once without a revision, and only while it runs", async () => {
    const active = await installActive(db);
    expect(await stopPlugin(db, "acme.loyalty", "Stopped with the emergency switch.")).toBe(true);
    const stopped = await requirePluginInstallation(db, "acme.loyalty");
    expect(stopped).toMatchObject({ status: "disabled", failureReason: "Stopped with the emergency switch." });
    expect(stopped.revision).toBe(active.revision + 1);
    expect(await stopPlugin(db, "acme.loyalty", "again")).toBe(false);
    // Approving it again starts it and clears the reason.
    const restarted = await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: stopped.revision });
    expect(restarted).toMatchObject({ status: "active", failureReason: null });
  });

  it("stops every running third-party app and leaves first-party apps running", async () => {
    await installActive(db);
    await installActive(db, { id: "beta.reviews", name: "Beta Reviews" });
    await installActive(db, { id: "scalius.bkash", name: "bKash" }, "bundled");
    await installPlugin(db, { manifest: manifest({ id: "gamma.idle", name: "Idle" }), source: "upload", bundleSha256: SHA });
    expect(await stopThirdPartyPlugins(db, "Stopped with the emergency switch for all third-party apps.")).toEqual(["acme.loyalty", "beta.reviews"]);
    const statuses = sqlite.prepare("SELECT plugin_id, status FROM plugin_installations ORDER BY plugin_id").all();
    expect(statuses).toEqual([
      { plugin_id: "acme.loyalty", status: "disabled" },
      { plugin_id: "beta.reviews", status: "disabled" },
      { plugin_id: "gamma.idle", status: "installed" },
      { plugin_id: "scalius.bkash", status: "active" },
    ]);
  });

  it("treats a scalius.* app that did not ship with the deployment as third-party (audit R2 F6)", async () => {
    // Installs refuse this now; a row from before that rule is still stopped.
    await installActive(db, { id: "scalius.helper", name: "Helper" }, "bundled");
    sqlite.prepare("UPDATE plugin_installations SET source = 'registry' WHERE plugin_id = 'scalius.helper'").run();
    expect(isThirdPartyPlugin({ pluginId: "scalius.helper", source: "registry" })).toBe(true);
    expect(isThirdPartyPlugin({ pluginId: "scalius.bkash", source: "bundled" })).toBe(false);
    expect(await stopThirdPartyPlugins(db, "Stopped.")).toEqual(["scalius.helper"]);
  });

  it("counts one breach a minute, stops the app at the threshold and logs each one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    await installActive(db);
    const breach = () => recordPluginBreach(db, "acme.loyalty", { kind: "wall_time", detail: "event:order.paid ran longer than 10000 ms", threshold: 3 });
    expect(await breach()).toEqual({ counted: true, count: 1, stopped: false });
    expect(await breach()).toEqual({ counted: false, count: 0, stopped: false });
    vi.setSystemTime(new Date("2026-10-08T10:01:01Z"));
    expect(await breach()).toEqual({ counted: true, count: 2, stopped: false });
    vi.setSystemTime(new Date("2026-10-08T10:02:02Z"));
    expect(await breach()).toEqual({ counted: true, count: 3, stopped: true });
    const stopped = await requirePluginInstallation(db, "acme.loyalty");
    expect(stopped.status).toBe("disabled");
    expect(stopped.failureReason).toMatch(/Stopped automatically: it went over its limits 3 times within an hour \(last: run time\)/);
    const logs = await listPluginLogs(db, "acme.loyalty", { limit: 10 });
    expect(logs.filter((line) => line.source === "quota")).toHaveLength(4);
  });

  it("starts a new breach window after an hour without one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    await installActive(db);
    const breach = () => recordPluginBreach(db, "acme.loyalty", { kind: "storage", detail: "full", threshold: 2 });
    expect((await breach()).count).toBe(1);
    vi.setSystemTime(new Date("2026-10-08T11:30:00Z"));
    expect(await breach()).toEqual({ counted: true, count: 1, stopped: false });
    expect((await requirePluginInstallation(db, "acme.loyalty")).status).toBe("active");
  });

  it("records data updates once, keeps them with kept data and forgets them with deleted data", async () => {
    const migrations = [{ version: 1, description: "Seed" }, { version: 2, description: "Backfill" }];
    const active = await installActive(db, { migrations });
    expect(pendingPluginMigrations(active.manifest, active.migratedVersion).map((entry) => entry.version)).toEqual([1, 2]);
    await recordPluginMigration(db, { pluginId: "acme.loyalty", version: 1, pluginVersion: "1.0.0", durationMs: 12 });
    await recordPluginMigration(db, { pluginId: "acme.loyalty", version: 1, pluginVersion: "1.0.0", durationMs: 99 });
    await recordPluginMigration(db, { pluginId: "acme.loyalty", version: 2, pluginVersion: "1.0.0", durationMs: 5 });
    expect((await listPluginMigrations(db, "acme.loyalty")).map((entry) => [entry.version, entry.durationMs])).toEqual([[1, 12], [2, 5]]);
    const migrated = await requirePluginInstallation(db, "acme.loyalty");
    expect(migrated.migratedVersion).toBe(2);
    expect(pendingPluginMigrations(migrated.manifest, migrated.migratedVersion)).toEqual([]);

    await uninstallPlugin(db, "acme.loyalty", { keepData: true, expectedRevision: migrated.revision });
    const reinstalled = await installPlugin(db, { manifest: manifest({ migrations }), source: "upload", bundleSha256: SHA });
    expect(reinstalled.migratedVersion).toBe(2);

    await uninstallPlugin(db, "acme.loyalty", { keepData: false, expectedRevision: reinstalled.revision });
    expect(await listPluginMigrations(db, "acme.loyalty")).toEqual([]);
    const fresh = await installPlugin(db, { manifest: manifest({ migrations }), source: "upload", bundleSha256: SHA });
    expect(fresh.migratedVersion).toBe(0);
  });

  it("measures stored bytes and picks the longest-unmeasured app once a day", async () => {
    await installActive(db);
    await installActive(db, { id: "beta.other", name: "Other" });
    await putObjectRecord(db, "beta.other", "ledger", LEDGER, "other", { note: "other app".repeat(50) });
    await putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "r1", { customer_id: "c1", note: "x".repeat(100) });
    await setPluginKv(db, "acme.loyalty", "cursor", { at: 1 });
    expect(await pluginDueForStorageMeasurement(db)).toBe("acme.loyalty");
    const bytes = await measurePluginStorage(db, "acme.loyalty");
    expect(bytes).toBeGreaterThan(100);
    expect(bytes).toBeLessThan(200);
    expect((await requirePluginInstallation(db, "acme.loyalty")).storageBytes).toBe(bytes);
    expect(await pluginDueForStorageMeasurement(db)).toBe("beta.other");
  });

  it("measures the app due in one statement, and nothing when none is due", async () => {
    await installActive(db);
    await putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "r1", { customer_id: "c1", note: "y".repeat(50) });
    const [measured] = await measureDuePluginStorageStatement(db);
    expect(measured).toMatchObject({ pluginId: "acme.loyalty" });
    expect(measured!.bytes).toBeGreaterThan(50);
    expect((await requirePluginInstallation(db, "acme.loyalty")).storageBytes).toBe(measured!.bytes);
    expect(await measureDuePluginStorageStatement(db)).toEqual([]);
  });

  it("puts back the release an update replaced, with its grant, status and settings", async () => {
    const before = await installActive(db, { settings: [{ key: "rate", label: "Rate", type: "number", default: 1 }] });
    const updated = await updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "2.0.0", objects: { ledger: LEDGER, extra: LEDGER } }),
      source: "upload",
      bundleSha256: SHA2,
      expectedRevision: before.revision,
      signerKeyId: "0123456789abcdef",
    });
    expect(updated).toMatchObject({ version: "2.0.0", bundleSha256: SHA2, signerKeyId: "0123456789abcdef" });
    const restored = await restorePluginRelease(db, before, { expectedRevision: updated.revision, reason: "Update to 2.0.0 was rolled back." });
    expect(restored).toMatchObject({
      version: "1.0.0",
      bundleSha256: SHA,
      status: "active",
      signerKeyId: null,
      failureReason: "Update to 2.0.0 was rolled back.",
      storedSettings: { rate: 1 },
    });
    expect(restored.grant).toEqual(before.grant);
    expect(Object.keys(restored.manifest.objects)).toEqual(["ledger"]);
    expect(sqlite.prepare("SELECT type FROM object_types WHERE namespace = 'acme.loyalty'").all()).toEqual([{ type: "ledger" }]);
    await expect(restorePluginRelease(db, before, { expectedRevision: updated.revision, reason: "again" }))
      .rejects.toMatchObject({ pluginCode: "installation_revision_conflict" });
  });

  it("keeps app objects on keep-data uninstall and cascades them on delete-data uninstall", async () => {
    const active = await installActive(db);
    await putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "r1", { note: "kept" });
    await uninstallPlugin(db, "acme.loyalty", { keepData: true, expectedRevision: active.revision });
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).toEqual({ note: "kept" });
    const reinstalled = await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA });
    await uninstallPlugin(db, "acme.loyalty", { keepData: false, expectedRevision: reinstalled.revision });
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_types WHERE namespace = 'acme.loyalty'").get()).toEqual({ n: 0 });
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).toBeNull();
  });

  it("stops an update whose object schema cannot preserve stored values", async () => {
    const active = await installActive(db);
    await putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "r1", { note: "kept" });
    const changed = { ...LEDGER, fields: LEDGER.fields.map((field) => field.key === "note" ? { ...field, type: "boolean" as const } : field) };
    await expect(updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "2.0.0", objects: { ledger: changed } }),
      source: "upload", bundleSha256: SHA2, expectedRevision: active.revision,
    })).rejects.toMatchObject({ pluginCode: "installation_objects_invalid" });
    expect(await requirePluginInstallation(db, "acme.loyalty")).toMatchObject({ status: "failed" });
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).toEqual({ note: "kept" });
  });

  it("refuses a manifest built for another plugin API or a newer platform with a plain reason", async () => {
    await expect(installPlugin(db, { manifest: { ...manifest(), apiVersion: "2099-01" } as never, source: "upload", bundleSha256: SHA }))
      .rejects.toMatchObject({ pluginCode: "installation_incompatible", message: expect.stringMatching(/plugin API 2099-01/) });
    await expect(installPlugin(db, { manifest: manifest({ minPlatformVersion: "99.0.0" }), source: "upload", bundleSha256: SHA }))
      .rejects.toMatchObject({ pluginCode: "installation_incompatible", message: expect.stringMatching(/Needs Scalius 99\.0\.0/) });
  });
});
