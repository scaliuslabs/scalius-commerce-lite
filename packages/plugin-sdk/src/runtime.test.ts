// The plugin-side runtime both loaders share: handler checks before anything
// runs, the frozen ctx, bridge refusals rehydrated with their stable code,
// bounded logs, and no throw ever escaping an invocation.
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginObjectCollection } from "./context";
import { invokePluginDefinition, type PluginContextSeed, type PluginRuntimeBridge } from "./runtime";

const seed: PluginContextSeed = {
  plugin: { id: "acme.test", version: "1.0.0" },
  store: { name: "Shop", url: "https://shop.test", currency: "BDT", decimalPlaces: 2, timezone: "Asia/Dhaka", locale: "en" },
  settings: { greeting: "Hi" },
  objects: ["notes"],
  inventory: { events: ["order.*"], functions: ["checkout.discounts"], routes: { admin: [], public: ["ping"], webhooks: [] }, cron: [], providers: [] },
};

function bridge(overrides: Partial<PluginRuntimeBridge> = {}): PluginRuntimeBridge {
  const refuse = async () => {
    throw new Error("[object.undeclared_type] Object type is not declared.");
  };
  return {
    apiCall: vi.fn(), objectsGet: vi.fn(refuse), objectsGetByHandle: vi.fn(refuse), objectsWrite: vi.fn(), objectsQuery: vi.fn(), objectsCount: vi.fn(),
    kvGet: vi.fn(async () => ({ value: 3, revision: 1 })), kvSet: vi.fn(), kvDelete: vi.fn(), kvList: vi.fn(), httpFetch: vi.fn(async () => ({ status: 201, headers: {}, body: "{\"a\":1}" })),
    customFieldsGet: vi.fn(), customFieldsSet: vi.fn(), messagingEmail: vi.fn(), messagingSms: vi.fn(), messagingNotifyStaff: vi.fn(),
    ...overrides,
  } as PluginRuntimeBridge;
}

const definition = (overrides: Record<string, unknown> = {}) => ({
  default: {
    manifest: { id: "acme.test", version: "1.0.0" },
    events: { "order.*": vi.fn() },
    functions: { "checkout.discounts": (input: { n: number }, settings: Record<string, unknown>) => ({ n: input.n, greeting: settings.greeting }) },
    routes: { public: { ping: vi.fn(async () => ({ body: "pong" })) } },
    ...overrides,
  },
});

describe("invokePluginDefinition", () => {
  it("refuses modules whose handlers or identity disagree with the installation", async () => {
    const extra = await invokePluginDefinition(definition({ cron: { sneaky: vi.fn() } }), { kind: "function", point: "checkout.discounts", input: { n: 1 } }, seed, null);
    expect(extra).toMatchObject({ ok: false, error: { code: "plugin.handlers_mismatch", message: 'Cron job "sneaky" has a handler but is not declared in the manifest.' } });
    const other = await invokePluginDefinition(definition({ manifest: { id: "acme.other", version: "1.0.0" } }), { kind: "function", point: "checkout.discounts", input: { n: 1 } }, seed, null);
    expect(other).toMatchObject({ ok: false, error: { code: "plugin.identity_mismatch" } });
  });

  it("runs a pure function with its input and settings only", async () => {
    expect(await invokePluginDefinition(definition(), { kind: "function", point: "checkout.discounts", input: { n: 7 } }, seed, null))
      .toEqual({ ok: true, value: { n: 7, greeting: "Hi" }, error: null, logs: [], droppedLogs: 0 });
  });

  it("gives handlers a frozen ctx over the bridge and rehydrates refusals with their code", async () => {
    let seen: unknown;
    const module = definition({
      events: {
        "order.*": async (_event: unknown, ctx: PluginContext & { objects: Record<string, PluginObjectCollection | undefined> }) => {
          expect(Object.isFrozen(ctx) && Object.isFrozen(ctx.settings)).toBe(true);
          expect(ctx.objects.secrets).toBeUndefined();
          expect(await ctx.kv.get("n")).toBe(3);
          const response = await ctx.http.fetch("https://api.acme.example/x");
          expect([response.ok, response.status, await response.json()]).toEqual([true, 201, { a: 1 }]);
          try {
            await ctx.objects.notes!.get("x");
          } catch (error) {
            seen = error;
          }
          for (let index = 0; index < 105; index += 1) ctx.log.info(`line ${index}`);
        },
      },
    });
    const result = await invokePluginDefinition(module, { kind: "event", event: { id: "evt_1", topic: "order.paid", apiVersion: "2026-10", occurredAt: "", resource: { type: "order", id: "o" }, facts: {} } }, seed, bridge());
    expect(result.ok).toBe(true);
    expect(seen).toMatchObject({ name: "PluginPlatformError", code: "object.undeclared_type", message: "Object type is not declared." });
    expect(result.logs).toHaveLength(100);
    expect(result.droppedLogs).toBe(5);
  });

  it("turns a throw into a failed result and ignores events nobody subscribed", async () => {
    const throwing = definition({ routes: { public: { ping: () => { throw new RangeError("bad"); } } } });
    expect(await invokePluginDefinition(throwing, { kind: "route", surface: "public", name: "ping", request: {} as never }, seed, bridge()))
      .toMatchObject({ ok: false, error: { code: null, message: "RangeError: bad" } });
    expect(await invokePluginDefinition(definition(), { kind: "event", event: { topic: "product.created" } as never }, seed, bridge()))
      .toMatchObject({ ok: true, value: null });
    expect(await invokePluginDefinition(definition(), { kind: "lifecycle", hook: "install" }, seed, bridge())).toMatchObject({ ok: true });
  });
});
