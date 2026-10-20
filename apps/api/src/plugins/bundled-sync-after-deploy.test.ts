// A new deployment brings its bundled apps in step on its first tick, not on
// plugin maintenance's turn in the sweep rotation: an app whose manifest
// changed must not sit unreadable (its payment methods gone from checkout)
// for the ~23 minutes until that turn comes round.
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getPluginInstallation, readPluginInstallations } from "@scalius/core/modules/plugins";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { syncBundledPluginsOncePerDeploy } from "./scheduled";
import noorStored from "./testing/noor-1.1.0.stored.json";

const deployment = (id: string) => ({ CF_VERSION_METADATA: { id } }) as unknown as Env;

describe("bundled apps after a deploy", () => {
  it("syncs an outdated bundled row on the new version's first tick, once per version", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare(`INSERT INTO plugin_installations
      (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, activated_by, activated_at, revision)
      VALUES ('scalius.noor', '1.1.0', 'bundled', ?, ?, ?, ?, 'active', 'owner', unixepoch(), 9)`)
      .run("ab".repeat(32), JSON.stringify(noorStored.manifest), JSON.stringify(noorStored.grant), JSON.stringify(noorStored.grant));
    expect((await readPluginInstallations(db)).unreadable.map((row) => row.pluginId)).toEqual(["scalius.noor"]);

    // Free syncs one bundled app per tick and keeps going on the next ticks
    // until every app matches the deployed code.
    const bundled = Object.keys(BUNDLED_PLUGINS).length;
    const updated: string[] = [];
    let ticks = 0;
    for (let result = await syncBundledPluginsOncePerDeploy(db, deployment("v-new")); result; result = await syncBundledPluginsOncePerDeploy(db, deployment("v-new"))) {
      ticks += 1;
      expect(result.installed.length + result.updated.length).toBeLessThanOrEqual(1);
      updated.push(...result.updated);
      if (!result.pending) break;
    }
    expect(ticks).toBe(bundled);
    expect(updated).toContain("scalius.noor");
    expect(await getPluginInstallation(db, "scalius.noor")).toMatchObject({ bundleSha256: BUNDLED_PLUGINS["scalius.noor"]!.sha256, status: "active" });

    // Later ticks of the same version do nothing; the next deployment syncs again.
    expect(await syncBundledPluginsOncePerDeploy(db, deployment("v-new"))).toBeNull();
    expect(await syncBundledPluginsOncePerDeploy(db, deployment("v-next"))).not.toBeNull();
    // No version metadata (local dev without it): leave it to the rotation.
    expect(await syncBundledPluginsOncePerDeploy(db, {} as Env)).toBeNull();
    sqlite.close();
  });
});
