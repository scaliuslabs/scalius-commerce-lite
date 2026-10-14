// Bundled installations follow the deployed code: an app this deployment
// bundles is installed (and updated in place), and one it no longer bundles
// (`pnpm plugin remove`, or a test app that never shipped) is uninstalled
// with its data kept, so the Apps page lists only apps that can run.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  getPluginInstallation,
  getPluginKv,
  installPlugin,
  pluginNeedsApproval,
  readPluginInstallations,
  setPluginKv,
} from "@scalius/core/modules/plugins";
import { parsePluginManifest, pluginGrantRequest, type PluginGrantRequest } from "@scalius/shared/plugins/manifest";
import { syncBundledPlugin, syncBundledPlugins } from "./bundled-sync";
import { FIXTURE_APPS, HELLO_BUNDLED } from "./testing/fixture-apps";
import { manifest as helloManifest } from "./testing/apps/hello/src/index";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import noorStored from "./testing/noor-1.1.0.stored.json";

describe("bundled plugin sync", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  /** An installation row as stored, written directly (a past release's shape). */
  function storeRow(row: { pluginId: string; version: string; sha256: string; manifest: unknown; grant: unknown; status: string }) {
    sqlite.prepare(`INSERT INTO plugin_installations
      (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, activated_by, activated_at, revision)
      VALUES (?, ?, 'bundled', ?, ?, ?, ?, ?, 'owner', unixepoch(), 9)`)
      .run(row.pluginId, row.version, row.sha256, JSON.stringify(row.manifest), JSON.stringify(row.grant), JSON.stringify(row.grant), row.status);
  }

  const parsedHello = parsePluginManifest(helloManifest);
  if (!parsedHello.ok) throw new Error("The hello fixture manifest must parse.");
  const helloGrant = pluginGrantRequest(parsedHello.manifest);
  // Hello as a past release stored it, with a key this release no longer reads.
  const unreadableHello = { ...parsedHello.manifest, retiredField: true };

  it("installs every bundled app once and leaves the rows alone on the next sync", async () => {
    const first = await syncBundledPlugins(db, FIXTURE_APPS);
    expect(first.installed).toEqual(Object.keys(FIXTURE_APPS).sort());
    expect(await syncBundledPlugins(db, FIXTURE_APPS)).toEqual({ installed: [], updated: [], removed: [], failed: [], fxApps: false });
  });

  it("uninstalls a bundled app the deployment no longer carries and keeps its data", async () => {
    await syncBundledPlugins(db, { "acme.hello": HELLO_BUNDLED });
    await setPluginKv(db, "acme.hello", "paid_count", 3);
    const result = await syncBundledPlugins(db, {});
    expect(result.removed).toEqual(["acme.hello"]);
    expect(await getPluginInstallation(db, "acme.hello")).toBeNull();
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(3);
    // Added back, it installs again (waiting for approval) and finds its data.
    expect((await syncBundledPlugins(db, { "acme.hello": HELLO_BUNDLED })).installed).toEqual(["acme.hello"]);
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(3);
  });

  it("updates the demo's stored Noor 1.1.0 to the bundled Noor in place, still active (presentation needs no new approval)", async () => {
    // The live row as the deploy found it: stored before route-drawn sections
    // were retired, so every section carries `reads: []`.
    storeRow({ pluginId: "scalius.noor", version: "1.1.0", sha256: "ab".repeat(32), manifest: noorStored.manifest, grant: noorStored.grant, status: "active" });
    expect(await getPluginInstallation(db, "scalius.noor")).toMatchObject({ version: "1.1.0", status: "active" });
    const noor = BUNDLED_PLUGINS["scalius.noor"]!;
    const result = await syncBundledPlugins(db, { "scalius.noor": noor });
    expect(result).toMatchObject({ updated: ["scalius.noor"], failed: [] });
    // If a later Noor asks for scopes, hosts or providers, this expectation is
    // the one to change: it then waits for approval (`needsApproval`).
    expect(await getPluginInstallation(db, "scalius.noor")).toMatchObject({ version: noor.version, bundleSha256: noor.sha256, status: "active" });
  });

  it("rewrites a bundled row whose stored manifest no longer reads from the deployed code, keeping its approval", async () => {
    storeRow({ pluginId: "acme.hello", version: "0.3.0", sha256: "cd".repeat(32), manifest: unreadableHello, grant: helloGrant, status: "active" });
    expect(await getPluginInstallation(db, "acme.hello")).toBeNull();
    expect((await readPluginInstallations(db)).unreadable).toMatchObject([{ pluginId: "acme.hello", name: helloManifest.name, status: "active" }]);

    const result = await syncBundledPlugins(db, { "acme.hello": HELLO_BUNDLED });
    expect(result).toMatchObject({ updated: ["acme.hello"], failed: [] });
    expect(await getPluginInstallation(db, "acme.hello")).toMatchObject({ version: HELLO_BUNDLED.version, status: "active", grant: helloGrant });
  });

  it("repairs it the same way when the host or the layout meets it (one app)", async () => {
    storeRow({ pluginId: "acme.hello", version: HELLO_BUNDLED.version, sha256: HELLO_BUNDLED.sha256, manifest: unreadableHello, grant: helloGrant, status: "active" });
    expect(await syncBundledPlugin(db, "acme.hello", { "acme.hello": HELLO_BUNDLED })).toMatchObject({ status: "active" });
  });

  it("keeps an unreadable row whose new release asks for more access waiting for approval, visibly", async () => {
    const narrower: PluginGrantRequest = { ...helloGrant, scopes: [] };
    storeRow({ pluginId: "acme.hello", version: "0.3.0", sha256: "cd".repeat(32), manifest: unreadableHello, grant: narrower, status: "active" });
    expect((await syncBundledPlugins(db, { "acme.hello": HELLO_BUNDLED })).updated).toEqual(["acme.hello"]);
    const waiting = (await getPluginInstallation(db, "acme.hello"))!;
    expect(waiting).toMatchObject({ version: HELLO_BUNDLED.version, status: "installed", grant: narrower });
    expect(pluginNeedsApproval(waiting)).toBe(true);
  });

  it("marks a running app failed, with the reason, when its new release cannot be installed", async () => {
    storeRow({ pluginId: "acme.hello", version: "0.3.0", sha256: "cd".repeat(32), manifest: parsedHello.manifest, grant: helloGrant, status: "active" });
    const broken = {
      version: "9.0.0",
      sha256: "ef".repeat(32),
      load: async () => ({ default: { manifest: { ...helloManifest, version: "9.0.0", scopes: ["not_a_scope"] } } }),
    };
    const result = await syncBundledPlugins(db, { "acme.hello": broken });
    expect(result.failed).toMatchObject([{ pluginId: "acme.hello" }]);
    const failed = (await getPluginInstallation(db, "acme.hello"))!;
    expect(failed).toMatchObject({ version: "0.3.0", status: "failed" });
    expect(failed.failureReason).toMatch(/^Version 9\.0\.0 in this deployment could not be installed: /);
    // A deployment that can install it resumes it with the approval it had.
    await syncBundledPlugins(db, { "acme.hello": HELLO_BUNDLED });
    expect(await getPluginInstallation(db, "acme.hello")).toMatchObject({ version: HELLO_BUNDLED.version, status: "active", failureReason: null });
  });

  it("never touches an app installed from a registry or an upload", async () => {
    await installPlugin(db, { manifest: helloManifest, source: "registry", bundleSha256: "ab".repeat(32) });
    expect((await syncBundledPlugins(db, {})).removed).toEqual([]);
    expect(await getPluginInstallation(db, "acme.hello")).toMatchObject({ source: "registry" });
  });
});
