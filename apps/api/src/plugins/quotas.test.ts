// Quotas and data updates in the host (packages/plugin-sdk/docs/apps.md, "Quotas and
// kill switch", "Data updates"): pending data updates run before an app's
// next run and a failing one marks it failed; the plan's runs a minute,
// storage size and calls per run are refused and recorded as breaches; and
// repeated breaches stop the app.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  getPluginKv,
  installPlugin,
  listPluginLogs,
  listPluginMigrations,
  requirePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { definePlugin, type PluginContext } from "@scalius/plugin-sdk";
import { PluginHost } from "./host";
import { BundledLoader } from "./loaders/bundled";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

function manifest(extra: Record<string, unknown> = {}) {
  return {
    id: "acme.points",
    name: "Acme Points",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Points.",
    author: { name: "Acme" },
    events: ["order.paid"],
    limits: { cpuMs: 50, wallMs: 200 },
    ...extra,
  };
}

const event = { id: "evt_1", topic: "order.paid", occurredAt: "2026-10-08T00:00:00Z", resource: { type: "order", id: "o1" }, data: {} } as never;

describe("app quotas and data updates", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let module: unknown;
  let limiter: { limit: ReturnType<typeof vi.fn> };

  function host() {
    const loader = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {
      "acme.points": { version: "1.0.0", sha256: "a".repeat(64), load: async () => module },
    });
    return new PluginHost({ env, ctx: pluginTestCtx(), db, loaderFor: () => loader });
  }

  async function install(extra: Record<string, unknown> = {}): Promise<PluginInstallation> {
    const installed = await installPlugin(db, { manifest: manifest(extra), source: "upload", bundleSha256: "a".repeat(64) });
    return activatePlugin(db, "acme.points", { actorUserId: "owner", expectedRevision: installed.revision });
  }

  beforeEach(() => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    limiter = { limit: vi.fn(async () => ({ success: true })) };
    env = pluginTestEnv(binding, { RL_STANDARD: limiter });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  it("runs pending data updates once, in order, before the app's next run", async () => {
    const order: string[] = [];
    const migrations = [{ version: 1, description: "Seed" }, { version: 2, description: "Backfill" }];
    module = definePlugin({
      manifest: manifest({ migrations }) as never,
      events: { "order.paid": async () => { order.push("event"); } },
      migrations: {
        1: async (ctx: PluginContext) => { order.push("m1"); await ctx.kv.set("seeded", 1); },
        2: async () => { order.push("m2"); },
      },
    });
    const installation = await install({ migrations });
    const first = host();
    expect((await first.invokeEvent(installation, event)).ok).toBe(true);
    expect((await first.invokeEvent(installation, event)).ok).toBe(true);
    expect(order).toEqual(["m1", "m2", "event", "event"]);
    expect(await getPluginKv(db, "acme.points", "seeded")).toBe(1);
    // A later request reads the recorded marker and runs none again.
    const fresh = await requirePluginInstallation(db, "acme.points");
    expect(fresh.migratedVersion).toBe(2);
    expect((await host().invokeEvent(fresh, event)).ok).toBe(true);
    expect(order).toEqual(["m1", "m2", "event", "event", "event"]);
  });

  it("marks the app failed when a data update fails, and runs nothing after it", async () => {
    const order: string[] = [];
    const migrations = [{ version: 1, description: "Break" }];
    module = definePlugin({
      manifest: manifest({ migrations }) as never,
      events: { "order.paid": async () => { order.push("event"); } },
      migrations: { 1: async () => { throw new Error("no"); } },
    });
    const installation = await install({ migrations });
    const outcome = await host().invokeEvent(installation, event);
    expect(outcome).toMatchObject({ ok: false, failure: "migration_failed" });
    expect(order).toEqual([]);
    expect(await requirePluginInstallation(db, "acme.points")).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/Data update 1 failed/) });
    expect(await listPluginMigrations(db, "acme.points")).toEqual([]);
  });

  it("refuses a run over the runs-a-minute quota and records the breach", async () => {
    module = definePlugin({ manifest: manifest() as never, events: { "order.paid": async () => undefined } });
    const installation = await install();
    limiter.limit.mockResolvedValueOnce({ success: false });
    expect(await host().invokeEvent(installation, event)).toMatchObject({ ok: false, failure: "limited" });
    const logs = await listPluginLogs(db, "acme.points", { limit: 10 });
    expect(logs.some((line) => line.source === "quota" && /runs per minute/.test(line.message))).toBe(true);
    // Checkout functions are paced by checkout, never by this quota.
    limiter.limit.mockClear();
    await host().invokeFunction(installation, "checkout.discounts" as never, {});
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("stops an app that keeps running past its wall time", async () => {
    module = definePlugin({
      manifest: manifest() as never,
      events: { "order.paid": () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)) },
    });
    let installation = await install();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let minute = 0; minute < 5; minute += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 8, 10, minute * 2)));
        installation = await requirePluginInstallation(db, "acme.points");
        if (installation.status !== "active") break;
        expect(await host().invokeEvent(installation, event)).toMatchObject({ ok: false, failure: "timeout" });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(await requirePluginInstallation(db, "acme.points")).toMatchObject({
      status: "disabled",
      failureReason: expect.stringMatching(/Stopped automatically: it went over its limits 5 times within an hour \(last: run time\)/),
    });
  });

  it("refuses writes that add data once storage is full, but still allows deletes", async () => {
    const results: string[] = [];
    module = definePlugin({
      manifest: manifest({ objects: { notes: { name: "Notes", fields: [{ key: "text", name: "Text", type: "multi_line_text" }], indexes: [] } } }) as never,
      events: {
        "order.paid": async (_event, ctx) => {
          try {
            await ctx.objects.notes!.put("n1", { text: "hello" });
            results.push("put ok");
          } catch (error) {
            results.push(`put ${(error as { code?: string }).code}`);
          }
          await ctx.objects.notes!.delete("n0");
          results.push("delete ok");
        },
      },
    });
    await install({ objects: { notes: { name: "Notes", fields: [{ key: "text", name: "Text", type: "multi_line_text" }], indexes: [] } } });
    sqlite.prepare("UPDATE plugin_installations SET storage_bytes = ? WHERE plugin_id = 'acme.points'").run(10 * 1024 * 1024 * 1024);
    const full = await requirePluginInstallation(db, "acme.points");
    expect((await host().invokeEvent(full, event)).ok).toBe(true);
    expect(results).toEqual(["put quota_storage", "delete ok"]);
  });
});
