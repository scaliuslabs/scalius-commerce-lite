// The reference plugin (acme.hello) end to end through the bundled loader
// on the real migrated schema: its event handler calls an /api/v1 operation
// through the plugin principal (the real admin app and RBAC), writes objects
// and KV, its routes, cron job, lifecycle hook and checkout function run, and
// its log lines land masked in the plugin log.
import type { DatabaseSync } from "node:sqlite";
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { getObjectRecord, putObjectRecord } from "@scalius/core/modules/objects";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  getPluginKv,
  listPluginLogs,
  requirePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginHost } from "./host";
import { BundledLoader } from "./loaders/bundled";
import { runPluginFunctions } from "./functions";
import { installHello, pluginTestCtx, pluginTestEnv, testCart as cart } from "./testing/fixtures";
import helloModule from "./testing/apps/hello/src/index";

describe("acme.hello through the bundled loader", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let installation: PluginInstallation;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    installation = await installHello(db, sqlite);
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_hello1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed')`).run();
  });
  afterEach(() => sqlite.close());

  it("is a sample no store bundles: the tests run the build the first-party catalog records", async () => {
    const { BUNDLED_PLUGINS: deployed } = await vi.importActual<typeof import("./bundled.gen")>("./bundled.gen");
    expect(Object.hasOwn(deployed, "acme.hello")).toBe(false);
    expect(BUNDLED_PLUGINS["acme.hello"]).toMatchObject({ version: helloModule.manifest.version, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(helloModule.manifest.id).toBe("acme.hello");
  });

  it("handles order.paid: calls dashboard.resources.orders.get as the plugin, writes objects and KV, logs masked", async () => {
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });
    const outcome = await host.invokeEvent(installation, {
      id: "evt_1",
      topic: "order.paid",
      apiVersion: "2026-10",
      occurredAt: "2026-10-01T10:00:00.000Z",
      resource: { type: "order", id: "ord_hello1" },
      facts: { orderId: "ord_hello1" },
    });
    expect(outcome).toEqual({ ok: true, value: null, error: null });
    expect(await getObjectRecord(db, "acme.hello", "greetings", "ord_hello1")).toEqual({
      order_id: "ord_hello1",
      kind: "paid",
      created_at: Date.parse("2026-10-01T10:00:00.000Z"),
      greeting: "Salam",
      order_status: "confirmed",
    });
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(1);
    const logs = await listPluginLogs(db, "acme.hello");
    expect(logs).toEqual([expect.objectContaining({ level: "info", source: "event:order.paid", message: "Greeted a paid order", fields: { orderId: "ord_hello1", apiStatus: 200 } })]);
    const audit = sqlite.prepare("SELECT plugin_id, grant_id, owner_user_id, operation_id, outcome, http_status FROM agent_audit_events").all();
    expect(audit).toEqual([{ plugin_id: "acme.hello", grant_id: null, owner_user_id: "owner", operation_id: "dashboard.resources.orders.get", outcome: "success", http_status: 200 }]);
  });

  it("serves its admin and public routes and runs its cron job and lifecycle hook", async () => {
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });
    const request = { method: "GET", subpath: "", query: { name: "Karim" }, headers: {}, body: null, rawBody: null, staffId: null };
    const greet = await host.invokeRoute(installation, "public", "greet", request);
    expect(greet).toEqual({ ok: true, value: { status: 200, headers: {}, body: { message: "Salam, Karim!", visits: 1 } }, error: null });
    expect((await host.invokeRoute(installation, "public", "greet", request)).value?.body).toMatchObject({ visits: 2 });

    const now = Date.parse("2026-10-02T00:00:00.000Z");
    const declaration = installation.manifest.objects.greetings!;
    await putObjectRecord(db, "acme.hello", "greetings", declaration, "seed", {});
    await putObjectRecord(db, "acme.hello", "greetings", declaration, "old", { order_id: "old", kind: "paid", created_at: now - 40 * 86_400_000 });
    await putObjectRecord(db, "acme.hello", "greetings", declaration, "new", { order_id: "new", kind: "paid", created_at: now - 86_400_000 });
    const dashboard = await host.invokeRoute(installation, "admin", "dashboard", { ...request, query: {} });
    expect(dashboard.value?.body).toMatchObject({
      version: 1,
      root: {
        type: "page",
        children: [
          { type: "columns", children: [{ type: "stat", label: "Greeted orders", value: 3 }, { type: "stat", label: "Paid events", value: 0 }, { type: "stat", label: "New orders", value: 0 }] },
          expect.anything(),
          expect.anything(),
        ],
      },
    });

    expect(await host.invokeCron(installation, "tidy", new Date(now).toISOString())).toEqual({ ok: true, value: null, error: null });
    expect(await getObjectRecord(db, "acme.hello", "greetings", "old")).toBeNull();
    expect(await getObjectRecord(db, "acme.hello", "greetings", "new")).not.toBeNull();

    expect((await host.invokeLifecycle(installation, "activate")).ok).toBe(true);
    const messages = (await listPluginLogs(db, "acme.hello")).map((line) => `${line.source} ${line.message}`);
    expect(messages).toEqual(expect.arrayContaining(["cron:tidy Tidied old greetings", "lifecycle:activate Hello is active"]));
  });

  it("runs its checkout.discounts function with its settings and returns nothing below the minimum", async () => {
    const env = pluginTestEnv(binding);
    const results = await runPluginFunctions("checkout.discounts", { cart: cart(150_000) }, env, pluginTestCtx(), { db });
    expect(results).toEqual([{
      pluginId: "acme.hello",
      priority: 100,
      output: { discounts: [{ title: "Salam discount", target: { kind: "order" }, value: { type: "percentage", percent: 15 } }] },
    }]);
    expect(await runPluginFunctions("checkout.discounts", { cart: cart(50_000) }, env, pluginTestCtx(), { db }))
      .toEqual([{ pluginId: "acme.hello", priority: 100, output: { discounts: [] } }]);
  });

  it("never runs code that is not the installed version: an installation behind the deployed build is updated in place", async () => {
    sqlite.prepare("UPDATE plugin_installations SET bundle_sha256 = ? WHERE plugin_id = 'acme.hello'").run("f".repeat(64));
    const stale = await requirePluginInstallation(db, "acme.hello");
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });
    const outcome = await host.invokeCron(stale, "tidy", new Date().toISOString());
    expect(outcome).toMatchObject({ ok: false, failure: "outdated", error: expect.stringMatching(/was updated to/) });
    const fresh = await requirePluginInstallation(db, "acme.hello");
    // Same grant request: it stays active on the deployed fingerprint, and the next call runs.
    expect(fresh).toMatchObject({ status: "active", bundleSha256: BUNDLED_PLUGINS["acme.hello"]!.sha256 });
    expect((await host.invokeCron(fresh, "tidy", new Date().toISOString())).ok).toBe(true);
  });

  it("marks a plugin failed when this deployment does not carry its code at all", async () => {
    const env = pluginTestEnv(binding);
    const emptyDeployment = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {});
    const outcome = await new PluginHost({ env, ctx: pluginTestCtx(), db, loaderFor: () => emptyDeployment })
      .invokeCron(installation, "tidy", new Date().toISOString());
    expect(outcome).toMatchObject({ ok: false, failure: "load_failed", error: expect.stringMatching(/not compiled into this deployment/) });
    expect((await requirePluginInstallation(db, "acme.hello")).status).toBe("failed");
  });
});
