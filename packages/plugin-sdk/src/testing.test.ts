// The test harness's migration runner and the fixtures, over a small plugin.
import { describe, expect, it } from "vitest";
import { definePlugin, PLUGIN_API_VERSION, ui, type PluginManifestInput } from "./index";
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
    expect(await harness.runMigration(9)).toMatchObject({ ok: false, error: { code: "plugin_no_handler" } });
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
    expect(result).toMatchObject({ ok: false, value: null, error: { code: "function_invalid_output" } });
    expect(result.error?.message).toMatch(/^Invalid cart\.line_prices output at prices\.0\.unitPriceMinor: /);
  });

  it("parses the input with the point's schema and refuses an undeclared point", async () => {
    const harness = createPluginTestHarness({ default: strict({ prices: [] }) });
    await expect(harness.fn("cart.line_prices", { cart: fixtures.cart(), lines: [{ lineId: "line_1", source: "nowhere", bundle: null }] } as never))
      .rejects.toThrow(/Invalid cart\.line_prices input at lines\.0\.source/);
    await expect(harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput())).rejects.toThrow(/declares no checkout\.discounts/);
    expect(await harness.fn("cart.line_prices", { cart: fixtures.cart(), lines: [] })).toMatchObject({ ok: true, value: { prices: [] } });
  });

  it("never lets read_customers relay mail to any address, as the host does", async () => {
    const refused = createPluginTestHarness({ default: strict({ prices: [] }, ["read_customers"]) });
    expect(await refused.deliver(fixtures.event("order.created"))).toMatchObject({ ok: false, error: { code: "messaging_recipient_not_allowed" } });
    expect(refused.sent.emails).toEqual([]);
    const any = createPluginTestHarness({ default: strict({ prices: [] }, ["send_messages_any"]) });
    expect(await any.deliver(fixtures.event("order.created"))).toMatchObject({ ok: true });
    expect(any.sent.emails).toHaveLength(1);
  });

  it("messages a customer by id with read_customers, staff, and the addresses its declared recipient fields hold", async () => {
    const app = (scopes: PluginManifestInput["scopes"] = []) => definePlugin({
      manifest: {
        ...manifest, id: "acme.newsletter", scopes, functions: [], events: [], migrations: [],
        routes: { admin: [{ name: "send", methods: ["POST"] }], public: [], webhooks: [] },
        objects: { subscribers: { name: "Subscribers", fields: [{ key: "email", name: "Email", type: "single_line_text" }], unique: ["email"] } },
        messaging: { recipients: [{ object: "subscribers", field: "email" }] },
      },
      routes: {
        admin: {
          send: async (request, ctx) => {
            const body = request.body as { customerId?: string; to?: string; subscribe?: string };
            if (body.subscribe) await ctx.objects.subscribers!.put(body.subscribe, { email: body.subscribe });
            await ctx.messaging.email({ ...(body.customerId ? { customerId: body.customerId } : { to: body.to }), subject: "News", html: "<p>News</p>" });
            return { body: { sent: true } };
          },
        },
      },
    });
    const harness = createPluginTestHarness({ default: app() }, { staff: ["Owner@Shop.test"] });
    const send = (body: Record<string, unknown>) => harness.route("admin", "send", { method: "POST", body });
    expect(await send({ to: "owner@shop.test" })).toMatchObject({ ok: true });
    expect(await send({ to: "reader@example.test" })).toMatchObject({ ok: false, error: { code: "messaging_recipient_not_allowed" } });
    expect(await send({ to: "reader@example.test", subscribe: "reader@example.test" })).toMatchObject({ ok: true });
    expect(await send({ customerId: "cus_1" })).toMatchObject({ ok: false, error: { code: "messaging_not_allowed" } });
    expect(harness.sent.emails).toHaveLength(2);
    const customers = createPluginTestHarness({ default: app(["read_customers"]) });
    expect(await customers.route("admin", "send", { method: "POST", body: { customerId: "cus_1" } })).toMatchObject({ ok: true });
    // Size limits are the host's (PLUGIN_MESSAGE_LIMITS): HTML is measured in UTF-8 bytes.
    const big = definePlugin({
      manifest: { ...manifest, id: "acme.big", scopes: ["send_messages_any"], functions: [], events: ["order.created"], routes: { admin: [], public: [], webhooks: [] }, migrations: [] },
      events: { "order.created": async (event, ctx) => void await ctx.messaging.email({ to: "a@example.test", subject: "Big", html: "অ".repeat(40_000) }) },
    });
    expect(await createPluginTestHarness({ default: big }).deliver(fixtures.event("order.created")))
      .toMatchObject({ ok: false, error: { code: "messaging_invalid", message: expect.stringContaining("html is text of at most 102400 bytes.") } });
  });
});

describe("money in objects and custom fields", () => {
  it("reads and writes { amountMinor, currency } in the store currency, as the platform does", async () => {
    const wallet = definePlugin({
      manifest: {
        ...manifest, id: "acme.wallet", functions: [], events: [], migrations: [],
        routes: { admin: [{ name: "credit", methods: ["POST"] }], public: [], webhooks: [] },
        objects: { wallets: { name: "Wallets", fields: [{ key: "balance", name: "Balance", type: "money" }, { key: "history", name: "History", type: "list.money" }], indexes: ["balance"] } },
        customFields: [{ ownerType: "customer", key: "credit_limit", name: "Credit limit", type: "money" }],
      },
      routes: {
        admin: {
          credit: async (request, ctx) => {
            const body = request.body as { balance: unknown };
            await ctx.objects.wallets!.put("cus_1", { balance: body.balance, history: [body.balance] });
            await ctx.customFields.set("customer", "cus_1", { credit_limit: body.balance });
            const read = await ctx.objects.wallets!.get("cus_1");
            // What an app reads it can write back unchanged.
            await ctx.objects.wallets!.update("cus_1", { history: [...(read!.history as unknown[]), read!.balance] });
            const found = await ctx.objects.wallets!.query({ where: { balance: body.balance as never } });
            return { body: { read: await ctx.objects.wallets!.get("cus_1"), field: await ctx.customFields.get("customer", "cus_1"), found: found.records.length } };
          },
        },
      },
    });
    const harness = createPluginTestHarness({ default: wallet }, { store: { currency: "BDT", decimalPlaces: 2 } });
    const balance = fixtures.money(125_000);
    expect(balance).toEqual({ amountMinor: 125000, currency: "BDT" });
    expect(await harness.route("admin", "credit", { method: "POST", body: { balance } })).toMatchObject({
      ok: true,
      value: { body: { read: { balance, history: [balance, balance] }, field: { credit_limit: balance }, found: 1 } },
    });
    expect(harness.records.get("wallets")!.get("cus_1")).toEqual({ balance: 125000, history: [125000, 125000] });
    for (const refused of [1250, "1250.00", { amountMinor: 125000, currency: "USD" }]) {
      expect(await harness.route("admin", "credit", { method: "POST", body: { balance: refused } })).toMatchObject({ ok: false, error: { code: "object_invalid" } });
    }
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

describe("checkout answers and storefront extension inputs", () => {
  const giftManifest = {
    id: "acme.gift",
    name: "Gift",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Asks for a gift message.",
    author: { name: "Acme" },
    functions: [{ point: "checkout.discounts" }],
    checkout: { attributes: [{ key: "gift_message", label: "Gift message", type: "text", maxLength: 120 }] },
    storefront: { extensions: [{ target: "checkout.contact.after" }, { target: "order.confirmation" }] },
  } satisfies PluginManifestInput;
  const gift = definePlugin({
    manifest: giftManifest,
    functions: {
      // Echoes what it can see, so the test can assert the host's scoping.
      "checkout.discounts": (input) => ({
        discounts: [{ title: JSON.stringify(input.cart.attributes).slice(0, 80), target: { kind: "order" }, value: { type: "percentage", percent: 1 } }],
      }),
    },
    extensions: {
      "checkout.contact.after": (input) => ({ ui: ui.view([ui.text(`${input.attributes.gift_message ?? ""}|${input.cart?.lines.length ?? 0}`), ui.field("gift_message")]) }),
      "order.confirmation": (input) => ({ ui: input.order ? ui.view([ui.text(input.order.orderId)]) : null }),
    },
  });

  it("hands a function only its own app's answers, as the host does", async () => {
    const harness = createPluginTestHarness({ default: gift });
    const input = fixtures.checkoutDiscountsInput({ cart: { attributes: { "acme.gift.gift_message": "Hi", "acme.other.secret": "private" } } });
    const result = await harness.fn("checkout.discounts", input);
    expect(result.value?.discounts[0]?.title).toBe(JSON.stringify({ "acme.gift.gift_message": "Hi" }));
  });

  it("builds a valid extension input for each slot's page", async () => {
    const harness = createPluginTestHarness({ default: gift });
    const contact = fixtures.storefrontExtensionInput("checkout.contact.after", { attributes: { gift_message: "Hi" } });
    expect(contact).toMatchObject({ target: "checkout.contact.after", currency: "BDT", order: null, customer: null, cart: { lines: [expect.any(Object)] } });
    expect(await harness.extension(contact)).toMatchObject({ ok: true, value: { ui: expect.anything() } });
    expect(JSON.stringify((await harness.extension(contact)).value)).toContain("Hi|1");
    const confirmation = fixtures.storefrontExtensionInput("order.confirmation");
    expect(confirmation).toMatchObject({ cart: null, customer: null, order: { orderId: "order_test_1" } });
    expect(JSON.stringify((await harness.extension(confirmation)).value)).toContain("order_test_1");
    expect(fixtures.storefrontExtensionInput("account.overview")).toMatchObject({ customer: { id: "cust_test_1" }, cart: null, order: null });
    expect(fixtures.storefrontExtensionInput("cart_drawer.footer", { cart: null }).cart).toBeNull();
  });
});

describe("the harness's customer roles and jobs", () => {
  const rolesManifest = {
    id: "acme.portal",
    name: "Portal",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "A seller portal.",
    author: { name: "Acme" },
    scopes: ["read_customers"],
    routes: { admin: [], public: [{ name: "portal", methods: ["GET", "POST"] }], webhooks: [] },
    storefront: { proxy: true },
    jobs: [{ name: "approve", title: "Approve sellers" }],
  } satisfies PluginManifestInput;
  const portal = definePlugin({
    manifest: rolesManifest,
    routes: {
      public: {
        portal: async (request, ctx) => {
          if (request.method === "POST") await ctx.customers.roles.grant(request.customer!.id, "seller", { ref: "seller_1" });
          return { body: { seller: request.customer?.roles.some((entry) => entry.role === "seller") ?? false, roles: request.customer?.roles ?? null } };
        },
      },
    },
    jobs: { approve: async (_ctx, job) => ({ state: { seen: job.step }, done: job.step >= 2 }) },
  });

  it("keeps the platform's role rules and hands a proxied buyer the app's roles", async () => {
    const harness = createPluginTestHarness({ default: portal }, { customers: ["c1"] });
    expect((await harness.route("public", "portal", { customer: { id: "c1" } })).value).toEqual({ body: { seller: false, roles: [] } });
    await harness.route("public", "portal", { method: "POST", customer: { id: "c1" } });
    expect((await harness.route("public", "portal", { customer: { id: "c1" } })).value).toEqual({ body: { seller: true, roles: [{ role: "seller", ref: "seller_1" }] } });
    expect(harness.roles("c1")).toEqual([{ role: "seller", ref: "seller_1" }]);
    expect(await harness.route("public", "portal", { method: "POST", customer: { id: "c_missing" } })).toMatchObject({ ok: false, error: { code: "customers_not_found" } });
    const unscoped = createPluginTestHarness({ default: { ...portal, manifest: { ...rolesManifest, scopes: [] } } });
    expect(await unscoped.route("public", "portal", { method: "POST", customer: { id: "c1" } })).toMatchObject({ ok: false, error: { code: "customers_not_allowed" } });
  });

  it("steps a job with the state each step returned", async () => {
    const harness = createPluginTestHarness({ default: portal });
    const { job, steps } = await harness.runJob("approve");
    expect(job).toMatchObject({ status: "done", steps: 2 });
    expect(steps.map((step) => step.result.value)).toEqual([{ state: { seen: 1 }, done: false }, { state: { seen: 2 }, done: true }]);
  });
});
