// Typed order timeline lines from apps (`ctx.timeline.add`) through the
// bundled loader on the migrated schema: the Order tagger test app adds its
// "tagged" line when an order is paid, the dashboard's timeline (and the
// agent API that serves it) shows it with the app's name, a redelivered event
// adds nothing, and the bridge refuses an app without `orders.edit` or a kind
// its manifest does not declare.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import { listOrderTimeline } from "@scalius/core/modules/orders";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginBridgeHost } from "./bridge";
import { PluginHost, pluginBridgeAuthority } from "./host";
import { installHello, PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest as taggerManifest } from "./testing/apps/order-tagger/src/index";

describe("order timeline lines from apps", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;

  beforeEach(() => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, total_amount_minor)
      VALUES ('ord_t1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed', 150000)`).run();
  });
  afterEach(() => sqlite.close());

  async function installTagger() {
    sqlite.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: taggerManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.order-tagger"]!.sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, "acme.order-tagger", { tag: "vip" }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    return activatePlugin(db, "acme.order-tagger", { actorUserId: "owner", expectedRevision: configured.revision });
  }

  it("shows the app's typed line on the order timeline once, with its name, title, message and fields", async () => {
    const installation = await installTagger();
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });
    const event = {
      id: "evt_paid_1",
      topic: "order.paid" as const,
      apiVersion: "2026-10" as const,
      occurredAt: "2026-10-08T10:00:00.000Z",
      resource: { type: "order", id: "ord_t1" },
      facts: { orderId: "ord_t1" },
    };
    expect(await host.invokeEvent(installation, event)).toEqual({ ok: true, value: null, error: null });
    const timeline = await listOrderTimeline(db, "ord_t1");
    expect(timeline.map((line) => [line.kind, line.body, line.data])).toEqual([
      ["app_event", "#vip · Payment received. Ready to pack.", { pluginId: "acme.order-tagger", appName: "Order tagger", kind: "tagged", title: "Order tagged", fields: { tag: "vip" } }],
      ["placed", null, null],
    ]);
    // The same event again (its own record is gone, say): the idempotency key adds nothing.
    sqlite.prepare("DELETE FROM object_records WHERE type_id = 'oty_acme.order-tagger.tagged'").run();
    expect(await host.invokeEvent(installation, event)).toEqual({ ok: true, value: null, error: null });
    expect((await listOrderTimeline(db, "ord_t1")).filter((line) => line.kind === "app_event")).toHaveLength(1);
  });

  it("refuses an app without orders.edit, an undeclared kind and an order that does not exist", async () => {
    const hello = await installHello(db, sqlite);
    const runtime = { env: pluginTestEnv(binding), ctx: pluginTestCtx(), db: () => db, composedEnv: async () => pluginTestEnv(binding) };
    const helloBridge = new PluginBridgeHost({ pluginId: hello.pluginId, version: hello.version, authority: pluginBridgeAuthority(hello) }, runtime);
    await expect(helloBridge.timelineAdd({ orderId: "ord_t1", kind: "greeted", message: "Hi" })).rejects.toThrow("[timeline_not_allowed]");

    const tagger = await installTagger();
    const bridge = new PluginBridgeHost({ pluginId: tagger.pluginId, version: tagger.version, authority: pluginBridgeAuthority(tagger) }, runtime);
    await expect(bridge.timelineAdd({ orderId: "ord_t1", kind: "shipped", message: "Gone" })).rejects.toThrow("[timeline_undeclared]");
    await expect(bridge.timelineAdd({ orderId: "ord_none", kind: "tagged", message: "Gone" })).rejects.toThrow("[timeline_not_found]");
    await expect(bridge.timelineAdd({ orderId: "ord_t1", kind: "tagged", message: "x".repeat(501) })).rejects.toThrow("[timeline_invalid]");
    await expect(bridge.timelineAdd({ orderId: "ord_t1", kind: "tagged", message: "Ok", fields: { "bad key": 1 } })).rejects.toThrow("[timeline_invalid]");
    expect(await bridge.timelineAdd({ orderId: "ord_t1", kind: "tagged", message: "Packed", fields: { boxes: 2, fragile: true } }))
      .toEqual({ id: expect.stringMatching(/^oev_/) });
  });
});
