// Bundled installations follow the deployed code: an app this deployment
// bundles is installed (and updated in place), and one it no longer bundles
// (`pnpm plugin remove`, or a test app that never shipped) is uninstalled
// with its data kept, so the Apps page lists only apps that can run.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getPluginInstallation, getPluginKv, installPlugin, setPluginKv } from "@scalius/core/modules/plugins";
import { syncBundledPlugins } from "./bundled-sync";
import { FIXTURE_APPS, HELLO_BUNDLED } from "./testing/fixture-apps";
import { manifest as helloManifest } from "./testing/apps/hello/src/index";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import noorStored from "./testing/noor-1.1.0.stored.json";

describe("bundled plugin sync", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

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
    sqlite.prepare(`INSERT INTO plugin_installations
      (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, activated_at, revision)
      VALUES ('scalius.noor', '1.1.0', 'bundled', ?, ?, ?, ?, 'active', unixepoch(), 9)`)
      .run("ab".repeat(32), JSON.stringify(noorStored.manifest), JSON.stringify(noorStored.grant), JSON.stringify(noorStored.grant));
    expect(await getPluginInstallation(db, "scalius.noor")).toMatchObject({ version: "1.1.0", status: "active" });
    const noor = BUNDLED_PLUGINS["scalius.noor"]!;
    const result = await syncBundledPlugins(db, { "scalius.noor": noor });
    expect(result).toMatchObject({ updated: ["scalius.noor"], failed: [] });
    // If a later Noor asks for scopes, hosts or providers, this expectation is
    // the one to change: it then waits for approval (`needsApproval`).
    expect(await getPluginInstallation(db, "scalius.noor")).toMatchObject({ version: noor.version, bundleSha256: noor.sha256, status: "active" });
  });

  it("never touches an app installed from a registry or an upload", async () => {
    await installPlugin(db, { manifest: helloManifest, source: "registry", bundleSha256: "ab".repeat(32) });
    expect((await syncBundledPlugins(db, {})).removed).toEqual([]);
    expect(await getPluginInstallation(db, "acme.hello")).toMatchObject({ source: "registry" });
  });
});
