// An app's sales channels (manifest `salesChannels`, MARKETS-DESIGN D6) on
// the real schema: installing adds them switched off, activating switches
// them on, deactivating off, an update renames and removes them, and an
// uninstall removes them unless an order names one. An app without channels
// writes no channel row.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import {
  activatePlugin,
  deactivatePlugin,
  installPlugin,
  requirePluginInstallation,
  uninstallPlugin,
  updatePluginInstallation,
} from "./index";

const SHA = "a".repeat(64);

function manifest(salesChannels: PluginManifestInput["salesChannels"], version = "1.0.0"): PluginManifestInput {
  return {
    id: "acme.tiktok",
    name: "Acme TikTok",
    version,
    apiVersion: PLUGIN_API_VERSION,
    description: "Sell on TikTok Shop.",
    author: { name: "Acme" },
    scopes: ["read_products"],
    ...(salesChannels ? { salesChannels } : {}),
  };
}

describe("an app's sales channels", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const channels = () => sqlite.prepare("SELECT id, name, kind, plugin_id AS pluginId, status FROM sales_channels WHERE plugin_id IS NOT NULL ORDER BY id").all();
  const revision = async () => (await requirePluginInstallation(db, "acme.tiktok")).revision;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("follows the manifest and the app's status", async () => {
    await installPlugin(db, { manifest: manifest([{ id: "shop", name: "TikTok Shop" }]), source: "upload", bundleSha256: SHA });
    expect(channels()).toEqual([{ id: "acme.tiktok:shop", name: "TikTok Shop", kind: "app", pluginId: "acme.tiktok", status: "inactive" }]);
    // A new channel sells every location (trigger).
    expect(sqlite.prepare("SELECT location_id AS location FROM sales_channel_locations WHERE channel_id = 'acme.tiktok:shop'").all())
      .toEqual([{ location: "loc_default" }]);

    await activatePlugin(db, "acme.tiktok", { actorUserId: "owner", expectedRevision: await revision() });
    expect(channels()).toMatchObject([{ status: "active" }]);

    await updatePluginInstallation(db, "acme.tiktok", {
      manifest: manifest([{ id: "shop", name: "TikTok" }, { id: "live", name: "TikTok Live" }], "1.1.0"),
      source: "upload",
      bundleSha256: SHA,
      expectedRevision: await revision(),
    });
    expect(channels()).toMatchObject([
      { id: "acme.tiktok:live", name: "TikTok Live", status: "active" },
      { id: "acme.tiktok:shop", name: "TikTok", status: "active" },
    ]);

    // An order names the live channel: dropping it switches it off instead of deleting it.
    sqlite.exec("INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, channel, sales_channel_id) VALUES ('o1', 'A', '+8801711111111', 'H', 'c', 'z', 'pending', 'app', 'acme.tiktok:live')");
    await updatePluginInstallation(db, "acme.tiktok", {
      manifest: manifest([{ id: "shop", name: "TikTok" }], "1.2.0"),
      source: "upload",
      bundleSha256: SHA,
      expectedRevision: await revision(),
    });
    expect(channels()).toMatchObject([
      { id: "acme.tiktok:live", status: "inactive" },
      { id: "acme.tiktok:shop", status: "active" },
    ]);

    await deactivatePlugin(db, "acme.tiktok", { expectedRevision: await revision() });
    expect(channels()).toMatchObject([{ status: "inactive" }, { status: "inactive" }]);

    await uninstallPlugin(db, "acme.tiktok", { keepData: false, expectedRevision: await revision() });
    expect(channels()).toMatchObject([{ id: "acme.tiktok:live", status: "inactive" }]);
  });

  it("writes no channel row for an app without channels", async () => {
    await installPlugin(db, { manifest: manifest(undefined), source: "upload", bundleSha256: SHA });
    await activatePlugin(db, "acme.tiktok", { actorUserId: "owner", expectedRevision: await revision() });
    expect(channels()).toEqual([]);
  });
});
