// Function points: every active implementation runs, results come back in
// priority-then-id order whatever order they finish in, invalid outputs,
// throws and timeouts are skipped and logged for the merchant (fail-open),
// and a point nobody implements does no plugin work at all.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, listPluginLogs } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import { runPluginFunctions } from "./functions";
import type { PluginLoader } from "./loaders/types";
import { pluginTestCtx, pluginTestEnv, testCart } from "./testing/fixtures";

function manifest(id: string, priority: number): PluginManifestInput {
  return {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Function test plugin.",
    author: { name: "Test" },
    functions: [{ point: "checkout.discounts", priority }],
    limits: { cpuMs: 50, wallMs: 100 },
  };
}

const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });
const discount = (title: string) => ({ discounts: [{ title, target: { kind: "order" }, value: { type: "fixed_amount", amountMinor: 500 } }] });

describe("runPluginFunctions", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    const created = createSqliteD1Database();
    ({ sqlite, db } = created);
    env = pluginTestEnv(created.binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  });
  afterEach(() => sqlite.close());

  async function activate(id: string, priority: number) {
    await installPlugin(db, { manifest: manifest(id, priority), source: "upload", bundleSha256: "2".repeat(64) });
    await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  it("does no plugin work when no active plugin implements the point", async () => {
    await installPlugin(db, { manifest: manifest("idle.plugin", 1), source: "upload", bundleSha256: "2".repeat(64) });
    const loaderFor = vi.fn();
    expect(await runPluginFunctions("checkout.discounts", { cart: testCart(1000) }, env, pluginTestCtx(), { db, loaderFor })).toEqual([]);
    expect(await runPluginFunctions("cart.validate", { cart: testCart(1000) }, env, pluginTestCtx(), { db, loaderFor })).toEqual([]);
    expect(loaderFor).not.toHaveBeenCalled();
  });

  it("orders results by priority then plugin id, skipping invalid outputs, throws and timeouts", async () => {
    await activate("slow.late", 1);
    await activate("zeta.good", 20);
    await activate("alpha.good", 20);
    await activate("beta.invalid", 5);
    await activate("gamma.throws", 7);
    await activate("first.good", 1);
    const loader: PluginLoader = {
      kind: "bundled",
      async invoke({ installation, invocation }) {
        expect(invocation).toMatchObject({ kind: "function", point: "checkout.discounts", input: { cart: expect.objectContaining({ subtotalMinor: 150_000 }) } });
        switch (installation.pluginId) {
          case "slow.late":
            return new Promise<PluginInvocationResult>(() => undefined);
          case "zeta.good":
            return ok(discount("Zeta"));
          case "alpha.good":
            // Asynchronous but well inside the limit, without depending on the
            // wall clock (a loaded machine stretched a real 20 ms sleep past it).
            await Promise.resolve();
            await Promise.resolve();
            return ok(discount("Alpha"));
          case "beta.invalid":
            return ok({ discounts: [{ title: "Bad", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor: -5 } }] });
          case "gamma.throws":
            return { ok: false, value: null, error: { code: null, message: "TypeError: boom" }, logs: [], droppedLogs: 0 };
          default:
            return ok(discount("First"));
        }
      },
    };
    const results = await runPluginFunctions("checkout.discounts", { cart: testCart(150_000) }, env, pluginTestCtx(), { db, loaderFor: () => loader });
    expect(results.map((result) => [result.pluginId, result.priority, result.output.discounts[0]?.title])).toEqual([
      ["first.good", 1, "First"],
      ["alpha.good", 20, "Alpha"],
      ["zeta.good", 20, "Zeta"],
    ]);
    const incident = async (id: string) => (await listPluginLogs(db, id)).map((line) => `${line.level} ${line.source} ${line.message}`);
    expect(await incident("beta.invalid")).toEqual([expect.stringMatching(/^error host function:checkout\.discounts: Invalid checkout\.discounts output at discounts\.0\.value\.amountMinor/)]);
    expect(await incident("gamma.throws")).toEqual(["error host function:checkout.discounts: TypeError: boom"]);
    // A timeout is also a limit breach (quota log line; repeated breaches stop the app).
    // Two writes in the same instant (Workers freeze the clock in a request):
    // their relative order is not meaningful, so compare them as a set.
    const slowLines = await incident("slow.late");
    expect(slowLines).toHaveLength(2);
    expect(slowLines).toEqual(expect.arrayContaining([
      "error host function:checkout.discounts: function:checkout.discounts exceeded its 100 ms wall-time limit.",
      "error quota Over its run time limit: function:checkout.discounts ran longer than 100 ms",
    ]));
  });

  it("rejects an input that does not match the point's schema (a platform bug)", async () => {
    await activate("first.good", 1);
    await expect(runPluginFunctions("checkout.discounts", { cart: { ...testCart(10), currency: "TAKA" } }, env, pluginTestCtx(), { db, loaderFor: vi.fn() }))
      .rejects.toThrow(TypeError);
  });
});
