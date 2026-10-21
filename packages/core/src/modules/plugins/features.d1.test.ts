// App features on the real migrated schema (D1 semantics): every feature
// starts off and registers nothing; turning one on writes its grant and its
// registrations in one batch; turning it off revokes both; an off feature's
// settings stay stored but are not readable by the running app; an update
// keeps the features that are on and starts new ones off.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, pluginGrantKey, pluginGrantRequest, type PluginManifestInput } from "@scalius/shared/plugins";
import {
  PluginError,
  activatePlugin,
  describePluginSettings,
  effectivePluginPermissions,
  installPlugin,
  pluginNeedsApproval,
  requirePluginInstallation,
  setPluginFeature,
  updatePluginInstallation,
  writePluginSettings,
} from "./index";

const SHA = "d".repeat(64);
const KEY = "k".repeat(43);

const PACK: PluginManifestInput = {
  id: "acme.pack",
  name: "Acme pack",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A pack of services.",
  author: { name: "Acme" },
  events: ["order.created", "order.paid"],
  settings: [
    { key: "general", label: "General", type: "text" },
    { key: "pay_store", label: "Store", type: "text", group: "pay" },
  ],
  providers: { payment: [{ id: "pay", name: "Pay", chargeCurrencies: ["BDT"], operations: ["verifyReturn", "queryPayment"], settings: ["pay_store"] }] },
  cron: [{ name: "sync", schedule: "0 * * * *" }],
  features: [
    { id: "payments", name: "Pay", description: "Take payments.", allowedHosts: ["pay.example"], providers: ["pay"], events: ["order.paid"] },
    { id: "places", name: "Places", description: "Load places.", recommended: true, scopes: ["write_places"], cron: ["sync"] },
  ],
};

function registrations(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT kind, name FROM plugin_registrations WHERE plugin_id = 'acme.pack' ORDER BY kind, name").all()
    .map((row) => `${(row as { kind: string }).kind}:${(row as { name: string }).name}`);
}

describe("app features", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('second', 'Second', 'second@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("installs and activates with every feature off: only the base registers and is granted", async () => {
    await installPlugin(db, { manifest: PACK, source: "upload", bundleSha256: SHA });
    expect(registrations(sqlite)).toEqual(["event:order.created"]);
    const active = await activatePlugin(db, "acme.pack", { actorUserId: "owner", expectedRevision: 1 });
    expect(active.features).toEqual([]);
    expect(active.grant).toMatchObject({ features: [], scopes: [], providers: [], allowedHosts: [] });
    expect(active.manifest.providers).toEqual([]);
    expect(active.declaredManifest.providers.map((provider) => provider.id)).toEqual(["pay"]);
    expect(registrations(sqlite)).toEqual(["event:order.created"]);
  });

  it("turns a feature on with its own consent, and off again, registrations in step", async () => {
    await installPlugin(db, { manifest: PACK, source: "upload", bundleSha256: SHA });
    let app = await activatePlugin(db, "acme.pack", { actorUserId: "owner", expectedRevision: 1 });

    // Consent to something nobody was shown is refused.
    await expect(setPluginFeature(db, "acme.pack", {
      feature: "places", enabled: true, expectedRevision: app.revision, actorUserId: "second", expectedGrantKey: "stale",
    })).rejects.toMatchObject({ pluginCode: "installation_grant_changed" });

    const shown = pluginGrantKey(pluginGrantRequest(app.declaredManifest, ["places"]));
    const on = await setPluginFeature(db, "acme.pack", {
      feature: "places", enabled: true, expectedRevision: app.revision, actorUserId: "second", expectedGrantKey: shown,
    });
    app = on.installation;
    expect(on.changed).toBe(true);
    expect(app.features).toEqual(["places"]);
    expect(app.activatedBy).toBe("second");
    expect(app.grant).toMatchObject({ features: ["places"], scopes: ["write_places"] });
    expect([...effectivePluginPermissions(app.grant)]).toContain("settings.delivery_locations.import");
    expect(registrations(sqlite)).toEqual(["cron:sync", "event:order.created"]);

    const payments = await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: true, expectedRevision: app.revision, actorUserId: "owner" });
    app = payments.installation;
    expect(registrations(sqlite)).toEqual(["cron:sync", "event:order.created", "event:order.paid", "provider:payment"]);
    expect(app.grant?.allowedHosts).toEqual(["pay.example"]);

    // The same state again changes nothing (no revision churn).
    const again = await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: true, expectedRevision: app.revision });
    expect(again).toMatchObject({ changed: false, installation: { revision: app.revision } });

    const off = await setPluginFeature(db, "acme.pack", { feature: "places", enabled: false, expectedRevision: app.revision });
    app = off.installation;
    expect(app.features).toEqual(["payments"]);
    expect(app.grant).toMatchObject({ features: ["payments"], scopes: [] });
    expect(effectivePluginPermissions(app.grant).has("settings.delivery_locations.import")).toBe(false);
    expect(registrations(sqlite)).toEqual(["event:order.created", "event:order.paid", "provider:payment"]);
    // Off keeps the approver.
    expect(app.activatedBy).toBe("owner");
  });

  it("refuses to turn a feature on before the app runs, and unknown features", async () => {
    const installed = await installPlugin(db, { manifest: PACK, source: "upload", bundleSha256: SHA });
    await expect(setPluginFeature(db, "acme.pack", { feature: "places", enabled: true, expectedRevision: installed.revision }))
      .rejects.toMatchObject({ pluginCode: "installation_inactive" });
    await expect(setPluginFeature(db, "acme.pack", { feature: "ghost", enabled: true, expectedRevision: installed.revision }))
      .rejects.toBeInstanceOf(PluginError);
    await expect(setPluginFeature(db, "acme.pack", { feature: "places", enabled: true, expectedRevision: 99 }))
      .rejects.toMatchObject({ pluginCode: "installation_revision_conflict" });
  });

  it("keeps an off feature's settings stored but out of the running app", async () => {
    await installPlugin(db, { manifest: PACK, source: "upload", bundleSha256: SHA });
    let app = await activatePlugin(db, "acme.pack", { actorUserId: "owner", expectedRevision: 1 });
    app = (await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: true, expectedRevision: app.revision })).installation;
    app = await writePluginSettings(db, "acme.pack", { general: "g", pay_store: "store-1" }, { expectedRevision: app.revision, credentialEncryptionKey: KEY });
    app = (await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: false, expectedRevision: app.revision })).installation;
    expect(describePluginSettings(app).values).toEqual({ general: "g" });
    // Saving the visible settings keeps the off feature's stored value.
    app = await writePluginSettings(db, "acme.pack", { general: "h" }, { expectedRevision: app.revision, credentialEncryptionKey: KEY });
    expect(app.storedSettings).toEqual({ general: "h", pay_store: "store-1" });
    app = (await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: true, expectedRevision: app.revision })).installation;
    expect(describePluginSettings(app).values).toEqual({ general: "h", pay_store: "store-1" });
  });

  it("an update keeps the features that are on, starts new ones off, and re-asks when an on feature grows", async () => {
    await installPlugin(db, { manifest: PACK, source: "upload", bundleSha256: SHA });
    let app = await activatePlugin(db, "acme.pack", { actorUserId: "owner", expectedRevision: 1 });
    app = (await setPluginFeature(db, "acme.pack", { feature: "payments", enabled: true, expectedRevision: app.revision })).installation;

    const withNew: PluginManifestInput = {
      ...PACK,
      version: "1.1.0",
      features: [...PACK.features!, { id: "extra", name: "Extra", description: "More.", scopes: ["read_customers"] }],
    };
    app = await updatePluginInstallation(db, "acme.pack", { manifest: withNew, source: "upload", bundleSha256: SHA, expectedRevision: app.revision });
    expect(app.status).toBe("active");
    expect(app.features).toEqual(["payments"]);
    expect(pluginNeedsApproval(app)).toBe(false);

    const grown: PluginManifestInput = {
      ...withNew,
      version: "1.2.0",
      allowedHosts: ["base.example"],
      features: withNew.features!.map((feature) => (feature.id === "payments" ? { ...feature, allowedHosts: ["pay.example", "pay2.example"] } : feature)),
    };
    app = await updatePluginInstallation(db, "acme.pack", { manifest: grown, source: "upload", bundleSha256: SHA, expectedRevision: app.revision });
    expect(app.status).toBe("installed");
    expect(pluginNeedsApproval(app)).toBe(true);
    // Turning a feature off does not approve the waiting update.
    await expect(setPluginFeature(db, "acme.pack", { feature: "payments", enabled: false, expectedRevision: app.revision }))
      .rejects.toMatchObject({ pluginCode: "installation_needs_approval" });
    app = await activatePlugin(db, "acme.pack", { actorUserId: "owner", expectedRevision: app.revision });
    expect(app.grant?.allowedHosts).toEqual(["base.example", "pay.example", "pay2.example"]);
    expect((await requirePluginInstallation(db, "acme.pack")).features).toEqual(["payments"]);
  });
});
