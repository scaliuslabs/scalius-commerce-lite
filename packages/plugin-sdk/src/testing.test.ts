// The test harness's migration runner and the fixtures, over a small plugin.
import { describe, expect, it } from "vitest";
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "./index";
import { createPluginTestHarness, fixtures } from "./testing";
import * as fixturesModule from "./fixtures";

const manifest = {
  id: "acme.migrating",
  name: "Migrating",
  version: "1.2.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Seeds and reshapes its data.",
  author: { name: "Acme" },
  events: ["order.created"],
  functions: [{ point: "checkout.discounts" }],
  routes: { admin: [{ name: "overview", methods: ["GET"] }], public: [], webhooks: [] },
  migrations: [
    { version: 1, description: "Seed the install note" },
    { version: 2, description: "Count the notes" },
  ],
} satisfies PluginManifestInput;

function plugin(overrides: { failSecond?: boolean } = {}) {
  return definePlugin({
    manifest,
    events: {
      "order.created": async (event, ctx) => {
        await ctx.kv.set("last_order", event.resource.id);
      },
    },
    functions: {
      "checkout.discounts": (input) => ({
        discounts: input.cart.subtotalMinor >= 100_000
          ? [{ title: "Big basket", target: { kind: "order" }, value: { type: "percentage", percent: 5 } }]
          : [],
      }),
    },
    routes: { admin: { overview: (request) => ({ body: { cursor: request.query.cursor ?? null, staff: request.staffId } }) } },
    migrations: {
      "1": async (ctx) => {
        // Idempotent: a second run keeps what the first wrote.
        if ((await ctx.kv.get("install_note")) === null) await ctx.kv.set("install_note", "installed");
      },
      "2": async (ctx) => {
        if (overrides.failSecond) throw new Error("cannot reshape");
        await ctx.kv.set("notes", (await ctx.kv.list("install")).length);
      },
    },
  });
}

describe("harness migrations", () => {
  it("runs one declared migration, and again without changing the result", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    expect(await harness.runMigration(1)).toMatchObject({ ok: true });
    harness.kv.set("install_note", "edited by the merchant");
    expect(await harness.runMigration(1)).toMatchObject({ ok: true });
    expect(harness.kv.get("install_note")).toBe("edited by the merchant");
  });

  it("runs every migration in order and reports each one", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    const run = await harness.runMigrations();
    expect(run.ok).toBe(true);
    expect(run.results.map((entry) => entry.version)).toEqual([1, 2]);
    expect(harness.kv.get("notes")).toBe(1);
  });

  it("runs only the migrations newer than the applied version", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    const run = await harness.runMigrations({ from: 1 });
    expect(run.results.map((entry) => entry.version)).toEqual([2]);
    expect(harness.kv.has("install_note")).toBe(false);
  });

  it("stops at the first failing migration, as the platform does", async () => {
    const harness = createPluginTestHarness({ default: plugin({ failSecond: true }) });
    const run = await harness.runMigrations();
    expect(run.ok).toBe(false);
    expect(run.results.map((entry) => [entry.version, entry.result.ok])).toEqual([[1, true], [2, false]]);
    expect(run.results[1]?.result.error?.message).toContain("cannot reshape");
  });

  it("refuses a migration the manifest does not declare", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    expect(await harness.runMigration(9)).toMatchObject({ ok: false, error: { code: "plugin.no_handler" } });
  });
});

describe("the harness is as strict as the platform", () => {
  const strict = (answer: unknown, scopes: PluginManifestInput["scopes"] = []) => definePlugin({
    manifest: { ...manifest, id: "acme.strict", scopes, functions: [{ point: "cart.line_prices" }], events: ["order.created"], routes: { admin: [], public: [], webhooks: [] }, migrations: [] },
    functions: { "cart.line_prices": () => answer as never },
    events: {
      "order.created": async (event, ctx) => {
        await ctx.messaging.email({ to: "buyer@example.test", subject: "Hi", html: "<p>Hi</p>" });
      },
    },
  });

  it("returns the host's function.invalid_output for an answer production would skip", async () => {
    const harness = createPluginTestHarness({ default: strict({ prices: [{ lineId: "line_1", unitPriceMinor: 0.5 }] }) });
    const result = await harness.fn("cart.line_prices", { cart: fixtures.cart(), lines: [{ lineId: "line_1", source: "base", bundle: null }] });
    expect(result).toMatchObject({ ok: false, value: null, error: { code: "function.invalid_output" } });
    expect(result.error?.message).toMatch(/^Invalid cart\.line_prices output at prices\.0\.unitPriceMinor: /);
  });

  it("parses the input with the point's schema and refuses an undeclared point", async () => {
    const harness = createPluginTestHarness({ default: strict({ prices: [] }) });
    await expect(harness.fn("cart.line_prices", { cart: fixtures.cart(), lines: [{ lineId: "line_1", source: "nowhere", bundle: null }] } as never))
      .rejects.toThrow(/Invalid cart\.line_prices input at lines\.0\.source/);
    await expect(harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput())).rejects.toThrow(/declares no checkout\.discounts/);
    expect(await harness.fn("cart.line_prices", { cart: fixtures.cart(), lines: [] })).toMatchObject({ ok: true, value: { prices: [] } });
  });

  it("refuses customer messages without read_customers, as the host does", async () => {
    const refused = createPluginTestHarness({ default: strict({ prices: [] }) });
    expect(await refused.deliver(fixtures.event("order.created"))).toMatchObject({ ok: false, error: { code: "messaging.not_allowed" } });
    expect(refused.sent.emails).toEqual([]);
    const allowed = createPluginTestHarness({ default: strict({ prices: [] }, ["read_customers"]) });
    expect(await allowed.deliver(fixtures.event("order.created"))).toMatchObject({ ok: true });
    expect(allowed.sent.emails).toHaveLength(1);
  });
});

describe("fixtures", () => {
  it("is the same export from the testing entry and the fixtures entry", () => {
    expect(fixtures).toBe(fixturesModule.fixtures);
  });

  it("builds events a harness can deliver, named after their topic", async () => {
    const event = fixtures.event("order.created");
    expect(event).toMatchObject({ topic: "order.created", resource: { type: "order" }, facts: {} });
    expect(fixtures.event("order.created").id).not.toBe(event.id);
    const harness = createPluginTestHarness({ default: plugin() });
    expect(await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o7" } }))).toMatchObject({ ok: true });
    expect(harness.kv.get("last_order")).toBe("o7");
  });

  it("builds a checkout input whose subtotal follows its lines, with overrides on top", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    const input = fixtures.checkoutDiscountsInput();
    expect(input.cart.subtotalMinor).toBe(100_000);
    expect((await harness.fn("checkout.discounts", input)).value).toMatchObject({ discounts: [{ title: "Big basket" }] });
    const small = fixtures.checkoutDiscountsInput({ cart: { lines: [fixtures.cartLine({ quantity: 1, lineTotalMinor: 50_000 })] } });
    expect(small.cart.subtotalMinor).toBe(50_000);
    expect((await harness.fn("checkout.discounts", small)).value).toEqual({ discounts: [] });
    expect(fixtures.checkoutDiscountsInput({ cart: { subtotalMinor: 7 } }).cart.subtotalMinor).toBe(7);
  });

  it("builds an admin request a route reads", async () => {
    const harness = createPluginTestHarness({ default: plugin() });
    expect((await harness.route("admin", "overview", fixtures.adminRouteRequest({ query: { cursor: "c1" } }))).value)
      .toEqual({ body: { cursor: "c1", staff: "staff_test" } });
  });
});
