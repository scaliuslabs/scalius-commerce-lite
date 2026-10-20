import { describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION } from "./api-version";
import { checkPluginHandlers, pluginEventHandlerKey, pluginHandlerInventory } from "./handlers";
import { parsePluginManifest } from "./manifest";

const parsed = parsePluginManifest({
  id: "acme.loyalty",
  name: "Acme Loyalty",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Points.",
  author: { name: "Acme" },
  events: ["order.*", "customer.created"],
  functions: [{ point: "checkout.discounts" }],
  routes: { admin: [{ name: "dashboard", methods: ["GET"] }], public: [], webhooks: [{ name: "acme-callback" }] },
  cron: [{ name: "expire", schedule: "0 3 * * *" }],
});
if (!parsed.ok) throw new Error("fixture");
const inventory = pluginHandlerInventory(parsed.manifest);
const handler = () => undefined;

const complete = {
  manifest: {},
  events: { "order.*": handler, "customer.created": handler },
  functions: { "checkout.discounts": handler },
  routes: { admin: { dashboard: handler }, webhooks: { "acme-callback": handler } },
  cron: { expire: handler },
  lifecycle: { activate: handler },
};

describe("plugin handler inventory", () => {
  it("accepts a module that implements exactly what the manifest declares", () => {
    expect(inventory).toEqual({
      events: ["order.*", "customer.created"],
      functions: ["checkout.discounts"],
      routes: { admin: ["dashboard"], public: [], webhooks: ["acme-callback"] },
      cron: ["expire"],
      providers: [],
      migrations: [],
    });
    expect(checkPluginHandlers(inventory, { default: complete })).toEqual([]);
    expect(checkPluginHandlers(inventory, complete)).toEqual([]);
  });

  it("rejects missing, undeclared and malformed handlers", () => {
    expect(checkPluginHandlers(inventory, { ...complete, cron: {} })).toEqual(['Cron job "expire" is declared in the manifest but has no handler.']);
    expect(checkPluginHandlers(inventory, { ...complete, events: { ...complete.events, "order.paid": handler } }))
      .toEqual(['Event "order.paid" has a handler but is not declared in the manifest.']);
    expect(checkPluginHandlers(inventory, { ...complete, routes: { ...complete.routes, public: { secret: handler } } }))
      .toEqual(['Public route "secret" has a handler but is not declared in the manifest.']);
    expect(checkPluginHandlers(inventory, { ...complete, functions: { "checkout.discounts": "nope" } }))
      .toEqual(['Function "checkout.discounts" must be a function.']);
    expect(checkPluginHandlers(inventory, { ...complete, lifecycle: { upgrade: handler } })).toEqual(['Unknown lifecycle hook "upgrade".']);
    expect(checkPluginHandlers(inventory, { ...complete, extra: true })).toEqual(['Unknown plugin definition key "extra".']);
    expect(checkPluginHandlers(inventory, null)).toHaveLength(1);
  });

  it("needs a handler for each declared data update, and none for undeclared ones", () => {
    const withMigrations = { ...inventory, migrations: ["1", "2"] };
    expect(checkPluginHandlers(withMigrations, { ...complete, migrations: { 1: handler, 2: handler } })).toEqual([]);
    expect(checkPluginHandlers(withMigrations, { ...complete, migrations: { 1: handler } }))
      .toEqual(['Migration "2" is declared in the manifest but has no handler.']);
    expect(checkPluginHandlers(inventory, { ...complete, migrations: { 3: handler } }))
      .toEqual(['Migration "3" has a handler but is not declared in the manifest.']);
  });

  it("delivers an event to the exact topic, else its resource wildcard, else *", () => {
    expect(pluginEventHandlerKey("customer.created", inventory.events)).toBe("customer.created");
    expect(pluginEventHandlerKey("order.paid", inventory.events)).toBe("order.*");
    expect(pluginEventHandlerKey("product.created", inventory.events)).toBeNull();
    expect(pluginEventHandlerKey("product.created", ["*"])).toBe("*");
  });
});
