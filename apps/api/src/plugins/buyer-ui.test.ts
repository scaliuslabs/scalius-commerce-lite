import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import type { RegisteredPlugin } from "@scalius/core/modules/plugins";
import type { FunctionCart } from "@scalius/shared/plugins";
import type { AppReadsCache } from "@scalius/core/modules/checkout";
import type { PluginHost } from "./host";
import { runPluginFunctions } from "./functions";
import { prepareBuyerUiBlocks } from "./buyer-ui";
const target = "checkout.actions.before" as const;
const registration = {
  name: "buyer.ui", priority: 100,
  installation: { pluginId: "test.notes", grant: { functions: [], extensions: [target] }, manifest: {
    functions: [],
    storefront: { proxy: true, extensions: [{ target, reads: [] }] }, routes: { public: [{ name: "redeem", methods: ["POST"] }] },
  } },
} as unknown as RegisteredPlugin;
const input = { target, language: "bn", locale: "bn-BD", currency: "BDT", cart: null, order: null, customer: { id: "cus_1" }, attributes: { "test.notes.gift": "hello", "other.app.secret": "private" } };
describe("buyer UI runtime", () => {
  it("runs only declared targets and exposes only the app's attributes", async () => {
    const invokeFunction = vi.fn().mockResolvedValue({ ok: true, value: { ui: { version: 1, root: { type: "text", text: "Hello" } } } });
    const options = { db: {} as Database, registered: [registration], host: { invokeFunction } as unknown as PluginHost };
    const results = await runPluginFunctions("buyer.ui", input, {} as Env, {} as ExecutionContext, options);
    expect(results).toHaveLength(1);
    expect(invokeFunction.mock.calls[0]![2]).toMatchObject({ attributes: { gift: "hello" }, customer: { id: "cus_1" } });
    expect(JSON.stringify(invokeFunction.mock.calls[0]![2])).not.toContain("private");
    expect(await runPluginFunctions("buyer.ui", { ...input, target: "account.profile" }, {} as Env, {} as ExecutionContext, options)).toEqual([]);
    expect(invokeFunction).toHaveBeenCalledTimes(1);
  });
  it("passes an extension only the reads its own slot declares", async () => {
    const note = { as: "note", object: "notes", key: "customer" };
    const tier = { as: "tier", object: "tiers", key: "customer" };
    const app = {
      name: "buyer.ui", priority: 100,
      installation: { pluginId: "test.notes", grant: { functions: [], extensions: [target, "account.overview"] }, manifest: {
        objects: {}, functions: [],
        storefront: { extensions: [{ target, reads: [note] }, { target: "account.overview", reads: [note, tier] }] },
      } },
    } as unknown as RegisteredPlugin;
    const invokeFunction = vi.fn().mockResolvedValue({ ok: true, value: { ui: null } });
    const cache = {
      remember: vi.fn(),
      get: vi.fn(async () => ({ ok: true, reads: { note: { revision: 1, data: {} }, tier: { revision: 1, data: {} } }, targets: {} })),
    };
    const options = { db: {} as Database, registered: [app], host: { invokeFunction } as unknown as PluginHost, reads: cache as unknown as AppReadsCache };
    await runPluginFunctions("buyer.ui", input, {} as Env, {} as ExecutionContext, options);
    await runPluginFunctions("buyer.ui", { ...input, target: "account.overview" }, {} as Env, {} as ExecutionContext, options);
    expect(Object.keys(invokeFunction.mock.calls[0]![2].reads)).toEqual(["note"]);
    expect(Object.keys(invokeFunction.mock.calls[1]![2].reads)).toEqual(["note", "tier"]);
  });
  it("passes each app only its own declared reads, and treats reads over their bounds as a failed answer", async () => {
    const reads = [{ as: "note", object: "notes", key: "customer" }];
    const withReads = (pluginId: string, onError: "skip" | "block") => ({
      name: "cart.validate", priority: 100,
      installation: { pluginId, grant: { functions: ["cart.validate"], blockingFunctions: ["cart.validate"] }, manifest: { objects: {}, functions: [{ point: "cart.validate", onError, reads }] } },
    }) as unknown as RegisteredPlugin;
    const invokeFunction = vi.fn().mockResolvedValue({ ok: true, value: { errors: [] } });
    const incident = vi.fn().mockResolvedValue(undefined);
    const cache = {
      remember: vi.fn(),
      get: vi.fn(async (_requests: unknown, _context: unknown, pluginId: string) => (pluginId === "test.ok"
        ? { ok: true, reads: { note: { revision: 2, data: { text: "hi" } } }, targets: {} }
        : { ok: false, reason: "Read note needs 120 records, more than its max of 100." })),
    };
    const cart: FunctionCart = { currency: "BDT", decimalPlaces: 2, channel: "online_store", salesChannelId: "sc_online_store", lines: [], subtotalMinor: 0, customer: null, destination: null, discountCodes: [], market: { id: "mkt_backup", country: null }, attributes: {} };
    const options = { db: {} as Database, host: { invokeFunction, incident } as unknown as PluginHost, reads: cache as unknown as AppReadsCache };
    expect(await runPluginFunctions("cart.validate", { cart }, {} as Env, {} as ExecutionContext, { ...options, registered: [withReads("test.ok", "skip"), withReads("test.over", "skip")] })).toHaveLength(1);
    expect(invokeFunction).toHaveBeenCalledTimes(1);
    expect(invokeFunction.mock.calls[0]![2]).toMatchObject({ reads: { note: { revision: 2, data: { text: "hi" } } } });
    expect(incident).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "test.over" }), "function:cart.validate", "Read note needs 120 records, more than its max of 100. The function did not run.");
    await expect(runPluginFunctions("cart.validate", { cart }, {} as Env, {} as ExecutionContext, { ...options, registered: [withReads("test.over", "block")] }))
      .rejects.toThrow("could not answer cart.validate");
  });
  it("rejects undeclared field/action references without reading media", async () => {
    const db = { select: vi.fn() } as unknown as Database;
    const block = { appId: "test.notes", releaseId: "a".repeat(64), target, attributes: [], values: {} };
    expect(await prepareBuyerUiBlocks(db, [
      { ...block, ui: { type: "field", attribute: "secret" } },
      { ...block, ui: { type: "button", label: "Act", action: { kind: "route", route: "undeclared" } } },
    ], [registration])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(await prepareBuyerUiBlocks(db, [{ ...block, ui: { type: "button", label: "Redeem", action: { kind: "route", route: "redeem" } } }], [registration])).toHaveLength(1);
  });
});
