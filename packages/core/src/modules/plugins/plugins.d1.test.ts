// Plugin persistence on the real migrated schema (D1 semantics): installation
// lifecycle and grants, sealed secret settings, declared objects with index
// and unique behaviour, KV TTLs, the masked log ring and the function-point
// registry.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { objectTypeDeclarationSchema, objectTypeId } from "@scalius/shared/plugins/objects";
import { countObjectRecords, deleteObjectRecord, getObjectRecord, putObjectRecord, queryObjectRecords } from "../objects";
import {
  PLUGIN_LOG_RING_SIZE,
  PluginError,
  activatePlugin,
  deactivatePlugin,
  deletePluginKv,
  describePluginSettings,
  getPluginKv,
  installPlugin,
  listActiveEventPlugins,
  listActiveFunctionPlugins,
  listPluginKv,
  listPluginLogs,
  readPluginRuntimeSettings,
  requirePluginInstallation,
  setPluginKv,
  uninstallPlugin,
  updatePluginInstallation,
  writePluginLogs,
  writePluginSettings,
} from "./index";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 7)).toString("base64");
const OTHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => 90 - index)).toString("base64");
const SHA = "a".repeat(64);

function manifest(overrides: Partial<PluginManifestInput> = {}): PluginManifestInput {
  return {
    id: "acme.loyalty",
    name: "Acme Loyalty",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Points for orders.",
    author: { name: "Acme" },
    scopes: ["read_orders"],
    events: ["order.*"],
    functions: [{ point: "checkout.discounts", priority: 50 }],
    objects: { ledger: LEDGER },
    settings: [
      { key: "rate", label: "Rate", type: "number", default: 1, min: 0, max: 10 },
      { key: "api_key", label: "API key", type: "secret", required: true },
    ],
    ...overrides,
  };
}

const LEDGER = objectTypeDeclarationSchema.parse({ name: "Ledger", fields: [
  { key: "customer_id", name: "Customer", type: "single_line_text" },
  { key: "kind", name: "Kind", type: "single_line_text" },
  { key: "at", name: "At", type: "integer" },
  { key: "ref", name: "Reference", type: "single_line_text" },
  { key: "points", name: "Points", type: "integer" },
], indexes: ["customer_id", ["kind", "at"]], unique: ["ref"] });

describe("plugin installations", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("installs with defaults and registrations, and refuses duplicates and anything but scopes", async () => {
    const installed = await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA, actorUserId: "owner" });
    expect(installed).toMatchObject({ pluginId: "acme.loyalty", status: "installed", revision: 1, grant: null });
    expect(installed.storedSettings).toEqual({ rate: 1 });
    expect(sqlite.prepare("SELECT kind, name, priority FROM plugin_registrations ORDER BY kind, name").all()).toEqual([
      { kind: "event", name: "order.*", priority: 100 },
      { kind: "function", name: "checkout.discounts", priority: 50 },
    ]);
    await expect(installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA }))
      .rejects.toMatchObject({ pluginCode: "installation_exists" });
    // Raw RBAC names (reserved or not) are not scopes: no scope reaches team, webhooks, agent access or apps.
    for (const scopes of [["team.manage"], ["webhooks.view"], ["orders.view"], ["manage_staff"]]) {
      await expect(installPlugin(db, { manifest: manifest({ id: "acme.raw", scopes: scopes as never }), source: "upload", bundleSha256: SHA }))
        .rejects.toMatchObject({ pluginCode: "manifest_invalid" });
    }
    // scalius.* belongs to apps bundled with Scalius, whatever path another arrives by (audit R2 F6).
    for (const source of ["upload", "registry"] as const) {
      await expect(installPlugin(db, { manifest: manifest({ id: "scalius.fake" }), source, bundleSha256: SHA }))
        .rejects.toMatchObject({ pluginCode: "manifest_reserved_vendor" });
    }
    await expect(installPlugin(db, { manifest: manifest({ id: "scalius.fake" }), source: "bundled", bundleSha256: SHA }))
      .resolves.toMatchObject({ pluginId: "scalius.fake" });
  });

  it("keeps the developer key an app was installed with: updates must be signed by it (audit R2 F6)", async () => {
    const SIGNER = "key_acme_0001";
    const installed = await installPlugin(db, { manifest: manifest(), source: "registry", bundleSha256: SHA, signerKeyId: SIGNER });
    expect(installed.signerKeyId).toBe(SIGNER);
    const update = (signerKeyId: string | null, source: "registry" | "upload" = "registry") => updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "1.1.0" }), source, bundleSha256: "b".repeat(64), expectedRevision: 1, signerKeyId,
    });
    // Another trusted developer cannot ship code under this app's id and grant, and neither can an unsigned upload.
    await expect(update("key_other_0002")).rejects.toMatchObject({ pluginCode: "signature_signer_changed" });
    await expect(update(null, "upload")).rejects.toMatchObject({ pluginCode: "signature_signer_changed" });
    expect(await requirePluginInstallation(db, "acme.loyalty")).toMatchObject({ version: "1.0.0", revision: 1, signerKeyId: SIGNER });
    await expect(update(SIGNER)).resolves.toMatchObject({ version: "1.1.0", signerKeyId: SIGNER });

    // An app installed unsigned takes the key of its first signed update, then keeps it.
    await installPlugin(db, { manifest: manifest({ id: "acme.unsigned" }), source: "upload", bundleSha256: SHA });
    const signedUpdate = (signerKeyId: string, expectedRevision: number) => updatePluginInstallation(db, "acme.unsigned", {
      manifest: manifest({ id: "acme.unsigned", version: `1.${expectedRevision}.0` }), source: "registry", bundleSha256: "c".repeat(64), expectedRevision, signerKeyId,
    });
    await expect(signedUpdate(SIGNER, 1)).resolves.toMatchObject({ signerKeyId: SIGNER });
    await expect(signedUpdate("key_other_0002", 2)).rejects.toMatchObject({ pluginCode: "signature_signer_changed" });
  });

  it("seals secrets, never echoes them, opens them only with the right key, and keeps them when omitted", async () => {
    await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA });
    await expect(activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: 1 }))
      .rejects.toMatchObject({ pluginCode: "installation_settings_incomplete" });

    await expect(writePluginSettings(db, "acme.loyalty", { rate: 3, api_key: "sk_live_secret_value" }, { expectedRevision: 1, credentialEncryptionKey: undefined }))
      .rejects.toMatchObject({ pluginCode: "settings_key_unavailable" });
    const written = await writePluginSettings(db, "acme.loyalty", { rate: 3, api_key: "sk_live_secret_value" }, { expectedRevision: 1, credentialEncryptionKey: KEY });
    const stored = String((sqlite.prepare("SELECT settings_json FROM plugin_installations").get() as { settings_json: string }).settings_json);
    expect(stored).not.toContain("sk_live_secret_value");
    expect(stored).toMatch(/"api_key":"ps1:/);
    expect(describePluginSettings(written)).toEqual({ values: { rate: 3 }, secrets: { api_key: true } });
    expect(JSON.stringify(describePluginSettings(written))).not.toContain("sk_live");

    expect(await readPluginRuntimeSettings(written, KEY)).toEqual({ values: { rate: 3, api_key: "sk_live_secret_value" }, unreadableSecrets: [] });
    expect(await readPluginRuntimeSettings(written, OTHER_KEY)).toEqual({ values: { rate: 3, api_key: null }, unreadableSecrets: ["api_key"] });

    // A sealed value moved to another plugin does not open.
    const moved = { ...written, pluginId: "acme.other" };
    expect((await readPluginRuntimeSettings(moved, KEY)).unreadableSecrets).toEqual(["api_key"]);

    const kept = await writePluginSettings(db, "acme.loyalty", { rate: 4 }, { expectedRevision: written.revision, credentialEncryptionKey: KEY });
    expect((await readPluginRuntimeSettings(kept, KEY)).values).toEqual({ rate: 4, api_key: "sk_live_secret_value" });
    await expect(writePluginSettings(db, "acme.loyalty", { rate: 4, api_key: null }, { expectedRevision: kept.revision, credentialEncryptionKey: KEY }))
      .rejects.toMatchObject({ pluginCode: "settings_invalid" });
    await expect(writePluginSettings(db, "acme.loyalty", { rate: 11 }, { expectedRevision: kept.revision, credentialEncryptionKey: KEY }))
      .rejects.toMatchObject({ pluginCode: "settings_invalid" });
    await expect(writePluginSettings(db, "acme.loyalty", { rate: 2 }, { expectedRevision: 1, credentialEncryptionKey: KEY }))
      .rejects.toMatchObject({ pluginCode: "installation_revision_conflict" });
  });

  it("activates with the approved grant, narrows without re-approval and waits for approval when an update widens it", async () => {
    await installPlugin(db, { manifest: manifest(), source: "upload", bundleSha256: SHA });
    const set = await writePluginSettings(db, "acme.loyalty", { rate: 1, api_key: "secret-1234" }, { expectedRevision: 1, credentialEncryptionKey: KEY });
    const active = await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: set.revision });
    expect(active).toMatchObject({ status: "active", activatedBy: "owner" });
    expect(active.grant?.scopes).toEqual(["read_orders"]);
    expect((await listActiveFunctionPlugins(db, "checkout.discounts")).map((row) => row.installation.pluginId)).toEqual(["acme.loyalty"]);

    const narrower = await updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "1.0.1", events: ["order.paid"] }),
      source: "upload",
      bundleSha256: "b".repeat(64),
      expectedRevision: active.revision,
    });
    expect(narrower).toMatchObject({ status: "active", version: "1.0.1" });
    expect(narrower.grant?.events).toEqual(["order.paid"]);
    expect((await readPluginRuntimeSettings(narrower, KEY)).values.api_key).toBe("secret-1234");
    expect(sqlite.prepare("SELECT name FROM plugin_registrations WHERE kind = 'event'").all()).toEqual([{ name: "order.paid" }]);

    const wider = await updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "1.1.0", scopes: ["read_orders", "read_customers"] }),
      source: "upload",
      bundleSha256: "c".repeat(64),
      expectedRevision: narrower.revision,
    });
    expect(wider.status).toBe("installed");
    expect(wider.grant?.scopes).toEqual(["read_orders"]);
    expect(await listActiveFunctionPlugins(db, "checkout.discounts")).toEqual([]);

    await expect(updatePluginInstallation(db, "acme.loyalty", {
      manifest: manifest({ version: "1.2.0" }),
      source: "upload",
      bundleSha256: "d".repeat(64),
      expectedRevision: narrower.revision,
    })).rejects.toMatchObject({ pluginCode: "installation_revision_conflict" });

    const reactivated = await activatePlugin(db, "acme.loyalty", { actorUserId: "owner", expectedRevision: wider.revision });
    expect(reactivated.grant?.scopes).toEqual(["read_customers", "read_orders"]);
    const disabled = await deactivatePlugin(db, "acme.loyalty", { expectedRevision: reactivated.revision });
    expect(disabled.status).toBe("disabled");
    expect(await listActiveEventPlugins(db, "order.created")).toEqual([]);
  });

  it("orders function implementations by priority then plugin id and skips inactive ones", async () => {
    for (const [id, priority] of [["zeta.one", 10], ["alpha.two", 10], ["beta.three", 5], ["gamma.off", 1]] as const) {
      await installPlugin(db, {
        manifest: manifest({ id, settings: [], functions: [{ point: "checkout.discounts", priority }] }),
        source: "upload",
        bundleSha256: SHA,
      });
      if (id !== "gamma.off") await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
    }
    const rows = await listActiveFunctionPlugins(db, "checkout.discounts");
    expect(rows.map((row) => [row.installation.pluginId, row.priority])).toEqual([["beta.three", 5], ["alpha.two", 10], ["zeta.one", 10]]);
    expect(await listActiveFunctionPlugins(db, "checkout.shipping_rates")).toEqual([]);
    expect((await listActiveEventPlugins(db, "order.paid")).map((row) => row.installation.pluginId)).toEqual(["alpha.two", "beta.three", "zeta.one"]);
  });

  it("uninstalls keeping or deleting data", async () => {
    await installPlugin(db, { manifest: manifest({ settings: [] }), source: "upload", bundleSha256: SHA });
    await putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "r1", { customer_id: "c1", kind: "earn", at: 1, ref: "x" });
    await setPluginKv(db, "acme.loyalty", "k", 1);
    await writePluginLogs(db, "acme.loyalty", [{ level: "info", source: "event:order.paid", message: "hi" }]);
    await uninstallPlugin(db, "acme.loyalty", { keepData: true, expectedRevision: 1 });
    expect(await requirePluginInstallation(db, "acme.loyalty").catch((error: unknown) => error)).toBeInstanceOf(PluginError);
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).not.toBeNull();
    // Keeping data keeps the log too (phase 2: keep or delete everything the plugin owns).
    expect((await listPluginLogs(db, "acme.loyalty")).map((line) => line.message)).toEqual(["hi"]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_registrations").get()).toEqual({ n: 0 });

    await installPlugin(db, { manifest: manifest({ settings: [] }), source: "upload", bundleSha256: SHA });
    await uninstallPlugin(db, "acme.loyalty", { keepData: false, expectedRevision: 1 });
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).toBeNull();
    expect(await getPluginKv(db, "acme.loyalty", "k")).toBeNull();
    expect(await listPluginLogs(db, "acme.loyalty")).toEqual([]);
  });
});

describe("plugin objects", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const put = (id: string, record: Record<string, unknown>) => putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, id, record);

  beforeEach(async () => {
    ({ sqlite, db } = createSqliteD1Database());
    for (const namespace of ["acme.loyalty", "acme.other"]) {
      sqlite.prepare("INSERT INTO object_types (id,namespace,type,name,fields_json,indexes_json,unique_json) VALUES (?,?,?,?,?,?,?)")
        .run(objectTypeId(namespace, "ledger"), namespace, "ledger", LEDGER.name, JSON.stringify(LEDGER.fields), JSON.stringify(LEDGER.indexes), JSON.stringify(LEDGER.unique));
    }
  });
  afterEach(() => sqlite.close());

  it("puts, gets, upserts and deletes records scoped to the app namespace and object type", async () => {
    await put("r1", { customer_id: "c1", kind: "earn", at: 3, ref: "o1", points: 10 });
    expect(await getObjectRecord(db, "acme.loyalty", "ledger", "r1")).toEqual({ customer_id: "c1", kind: "earn", at: 3, ref: "o1", points: 10 });
    expect(await getObjectRecord(db, "acme.other", "ledger", "r1")).toBeNull();
    expect(await getObjectRecord(db, "acme.loyalty", "other", "r1")).toBeNull();
    await put("r1", { customer_id: "c1", kind: "earn", at: 3, ref: "o1", points: 20 });
    expect((await getObjectRecord(db, "acme.loyalty", "ledger", "r1"))?.points).toBe(20);
    expect(await deleteObjectRecord(db, "acme.loyalty", "ledger", "r1")).toBe(true);
    expect(await deleteObjectRecord(db, "acme.loyalty", "ledger", "r1")).toBe(false);
  });

  it("enforces declared unique indexes and exempts records missing the field", async () => {
    await put("r1", { ref: "o1" });
    await expect(put("r2", { ref: "o1" })).rejects.toMatchObject({ objectCode: "object_unique_violation" });
    await put("r3", { customer_id: "c9" });
    await put("r4", { customer_id: "c9" });
    // Another plugin may use the same value.
    await putObjectRecord(db, "acme.other", "ledger", LEDGER, "r1", { ref: "o1" });
  });

  it("queries only through declared indexes: equality, prefix with order, keyset pages", async () => {
    for (let index = 0; index < 7; index += 1) {
      await put(`r${index}`, { customer_id: index % 2 === 0 ? "c-even" : "c-odd", kind: index < 5 ? "earn" : "burn", at: 100 - index * 10, ref: `o${index}` });
    }
    const even = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { where: { customer_id: "c-even" } });
    expect(even.records.map((record) => record.id)).toEqual(["r0", "r2", "r4", "r6"]);
    expect(await countObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { customer_id: "c-odd" })).toBe(3);
    expect(await countObjectRecords(db, "acme.loyalty", "ledger", LEDGER)).toBe(7);

    const firstPage = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, {
      where: { kind: "earn" },
      orderBy: { field: "at", direction: "asc" },
      limit: 2,
    });
    expect(firstPage.records.map((record) => record.data.at)).toEqual([60, 70]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, {
      where: { kind: "earn" },
      orderBy: { field: "at", direction: "asc" },
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.records.map((record) => record.data.at)).toEqual([80, 90]);
    const lastPage = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, {
      where: { kind: "earn" },
      orderBy: { field: "at", direction: "asc" },
      limit: 2,
      cursor: secondPage.nextCursor,
    });
    expect(lastPage).toEqual({ records: [expect.objectContaining({ id: "r0" })], nextCursor: null });

    const descending = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, {
      where: { kind: "earn" },
      orderBy: { field: "at", direction: "desc" },
    });
    expect(descending.records.map((record) => record.data.at)).toEqual([100, 90, 80, 70, 60]);
    // Numbers order numerically, negatives included.
    await put("neg", { kind: "earn", at: -5 });
    await expect(put("frac", { kind: "earn", at: 60.5 })).rejects.toMatchObject({ objectCode: "object_invalid" });
    const ordered = await queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { where: { kind: "earn" }, orderBy: { field: "at" } });
    expect(ordered.records.map((record) => record.data.at)).toEqual([-5, 60, 70, 80, 90, 100]);

    await expect(queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { where: { points: 1 } }))
      .rejects.toMatchObject({ objectCode: "object_unindexed_query" });
    await expect(queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { where: { kind: "earn" }, orderBy: { field: "ref" } }))
      .rejects.toMatchObject({ objectCode: "object_unindexed_query" });
    await expect(queryObjectRecords(db, "acme.loyalty", "ledger", LEDGER, { where: { kind: "burn" }, orderBy: { field: "at" }, cursor: firstPage.nextCursor }))
      .rejects.toMatchObject({ objectCode: "object_invalid_cursor" });
  });

  it("refuses invalid ids, oversized records and non-scalar indexed values", async () => {
    await expect(put("", {})).rejects.toMatchObject({ objectCode: "object_invalid_id" });
    await expect(put("x".repeat(129), {})).rejects.toMatchObject({ objectCode: "object_invalid_id" });
    await expect(put("big", { blob: "x".repeat(70_000) })).rejects.toMatchObject({ objectCode: "object_record_too_large" });
    await expect(put("obj", { customer_id: { nested: true } })).rejects.toMatchObject({ objectCode: "object_invalid" });
    await expect(putObjectRecord(db, "acme.loyalty", "ledger", LEDGER, "arr", [] as never)).rejects.toMatchObject({ objectCode: "object_invalid_record" });
  });
});

describe("plugin kv and logs", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  it("stores JSON values with TTLs and lists live keys by prefix", async () => {
    await setPluginKv(db, "acme.loyalty", "count", { n: 1 });
    await setPluginKv(db, "acme.loyalty", "cache:a", "A", { ttlSeconds: 60 });
    await setPluginKv(db, "acme.loyalty", "cache:b", "B", { ttlSeconds: 60 });
    expect(await getPluginKv(db, "acme.loyalty", "count")).toEqual({ n: 1 });
    expect(await listPluginKv(db, "acme.loyalty", "cache:")).toEqual(["cache:a", "cache:b"]);
    sqlite.prepare("UPDATE plugin_kv SET expires_at = unixepoch() - 1 WHERE key = 'cache:a'").run();
    expect(await getPluginKv(db, "acme.loyalty", "cache:a")).toBeNull();
    expect(await listPluginKv(db, "acme.loyalty")).toEqual(["cache:b", "count"]);
    // A later write prunes expired entries.
    await setPluginKv(db, "acme.loyalty", "count", { n: 2 });
    expect(sqlite.prepare("SELECT key FROM plugin_kv ORDER BY key").all()).toEqual([{ key: "cache:b" }, { key: "count" }]);
    await deletePluginKv(db, "acme.loyalty", "count");
    expect(await getPluginKv(db, "acme.loyalty", "count")).toBeNull();
    expect(await getPluginKv(db, "acme.other", "cache:b")).toBeNull();
    await expect(setPluginKv(db, "acme.loyalty", "x", "y", { ttlSeconds: 0 })).rejects.toMatchObject({ pluginCode: "kv_invalid_ttl" });
    await expect(setPluginKv(db, "acme.loyalty", "", "y")).rejects.toMatchObject({ pluginCode: "kv_invalid_key" });
  });

  it("masks secrets, credentials and contact details and keeps a bounded ring", async () => {
    await writePluginLogs(db, "acme.loyalty", [{
      level: "info",
      source: "event:order.paid",
      message: "Called with sk_live_9999 for buyer rahim@example.com at +8801711223344",
      fields: { apiKey: "abc", token: "t", nested: { password: "p", phone: "01711223344", ok: 5 }, note: "sk_live_9999" },
    }], { secrets: ["sk_live_9999"] });
    const [line] = await listPluginLogs(db, "acme.loyalty");
    expect(line!.message).toBe("Called with [secret] for buyer [email] at [number]");
    expect(line!.fields).toEqual({ apiKey: "[masked]", token: "[masked]", nested: { password: "[masked]", phone: "[number]", ok: 5 }, note: "[secret]" });

    const many = Array.from({ length: 50 }, (_, index) => ({ level: "debug" as const, source: "cron:tidy", message: `line ${index}` }));
    for (let round = 0; round < 11; round += 1) await writePluginLogs(db, "acme.loyalty", many);
    const kept = sqlite.prepare("SELECT count(*) AS n FROM plugin_log_entries WHERE plugin_id = 'acme.loyalty'").get() as { n: number };
    expect(kept.n).toBe(PLUGIN_LOG_RING_SIZE);
    const newest = await listPluginLogs(db, "acme.loyalty", { limit: 1 });
    expect(newest[0]!.message).toBe("line 49");
  });
});
