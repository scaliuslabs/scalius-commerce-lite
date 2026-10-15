import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import type { RegisteredPlugin } from "@scalius/core/modules/plugins";
import type { PluginHost } from "./host";
import { runPluginFunctions } from "./functions";
import { prepareBuyerUiBlocks } from "./buyer-ui";
const target = "purchase.checkout.actions.render-before" as const;
const registration = {
  name: "buyer.ui", priority: 100,
  installation: { pluginId: "test.notes", grant: { functions: ["buyer.ui"] }, manifest: {
    functions: [{ point: "buyer.ui", targets: [target], onError: "skip" }],
    storefront: { proxy: true }, routes: { public: [{ name: "redeem", methods: ["POST"] }] },
  } },
} as unknown as RegisteredPlugin;
const input = { target, language: "bn", locale: "bn-BD", currency: "BDT", cart: null, order: null, customer: { id: "cus_1" }, attributes: { "test.notes.gift": "hello", "other.app.secret": "private" } };
describe("buyer UI runtime", () => {
  it("runs only declared targets and exposes only the app's attributes", async () => {
    const invokeFunction = vi.fn().mockResolvedValue({ ok: true, value: { ui: { type: "text", text: "Hello" } } });
    const options = { db: {} as Database, registered: [registration], host: { invokeFunction } as unknown as PluginHost };
    const results = await runPluginFunctions("buyer.ui", input, {} as Env, {} as ExecutionContext, options);
    expect(results).toHaveLength(1);
    expect(invokeFunction.mock.calls[0]![2]).toMatchObject({ attributes: { gift: "hello" }, customer: { id: "cus_1" } });
    expect(JSON.stringify(invokeFunction.mock.calls[0]![2])).not.toContain("private");
    expect(await runPluginFunctions("buyer.ui", { ...input, target: "customer-account.profile.block.render" }, {} as Env, {} as ExecutionContext, options)).toEqual([]);
    expect(invokeFunction).toHaveBeenCalledTimes(1);
  });
  it("rejects undeclared field/action references without reading media", async () => {
    const db = { select: vi.fn() } as unknown as Database;
    const block = { appId: "test.notes", releaseId: "a".repeat(64), target, attributes: [], values: {} };
    expect(await prepareBuyerUiBlocks(db, [
      { ...block, ui: { type: "field", attribute: "secret" } },
      { ...block, ui: { type: "button", label: "Act", action: { kind: "app_route", route: "undeclared" } } },
    ], [registration])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(await prepareBuyerUiBlocks(db, [{ ...block, ui: { type: "button", label: "Redeem", action: { kind: "app_route", route: "redeem" } } }], [registration])).toHaveLength(1);
  });
});
