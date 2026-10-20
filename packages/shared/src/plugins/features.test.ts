// App features: every feature starts off, an off feature's items do not exist
// in the running manifest, grants record the features that are on, and the
// manifest refuses features that would break when one is off.
import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  parsePluginManifest,
  pluginFeatureRequest,
  pluginGrantAdditions,
  pluginGrantExpands,
  pluginGrantKey,
  pluginGrantRequest,
  pluginManifestWithFeatures,
  type PluginManifestInput,
} from "../plugins";
import { pluginHandlerInventory, checkPluginHandlers } from "./handlers";

const PACK: PluginManifestInput = {
  id: "acme.pack",
  name: "Acme pack",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A pack of services.",
  author: { name: "Acme" },
  scopes: ["read_orders"],
  allowedHosts: ["base.acme.example"],
  events: ["order.paid", "order.created"],
  settings: [
    { key: "general", label: "General", type: "text" },
    { key: "pay_key", label: "Key", type: "secret", group: "pay" },
    { key: "sms_token", label: "Token", type: "secret", group: "texts" },
  ],
  providers: {
    payment: [{ id: "pay", name: "Pay", flow: "hosted", chargeCurrencies: ["BDT"], operations: ["verifyReturn", "queryPayment"], settings: ["pay_key"] }],
    sms: [{ id: "sms", name: "SMS", settings: ["sms_token"] }],
  },
  routes: {
    admin: [{ name: "places", methods: ["GET"] }, { name: "home", methods: ["GET"] }],
    webhooks: [{ name: "pay-callback" }],
  },
  admin: {
    pages: [{ id: "places", title: "Places", route: "places" }, { id: "home", title: "Home", route: "home" }],
    settingsGroups: [{ id: "texts", title: "Texts" }],
  },
  cron: [{ name: "sync", schedule: "0 * * * *" }],
  features: [
    {
      id: "payments",
      name: "Pay",
      description: "Take payments.",
      allowedHosts: ["pay.example"],
      providers: ["pay"],
      routes: { webhooks: ["pay-callback"] },
      events: ["order.paid"],
    },
    {
      id: "places",
      name: "Places",
      description: "Load places.",
      recommended: true,
      scopes: ["write_places"],
      routes: { admin: ["places"] },
      admin: ["places"],
      cron: ["sync"],
    },
    { id: "texts", name: "Texts", description: "Send texts.", scopes: ["read_customer_phones"], providers: ["sms"], settingsGroups: ["texts"], allowedHosts: ["sms.example"] },
  ],
  translations: { bn: { features: { places: { name: "এলাকা" } } } },
};

function parse(input: PluginManifestInput) {
  const parsed = parsePluginManifest(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.manifest;
}

function issues(input: unknown) {
  const parsed = parsePluginManifest(input);
  return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe("app features", () => {
  it("runs only the base while every feature is off", () => {
    const declared = parse(PACK);
    expect(declared.features.map((feature) => [feature.id, feature.recommended])).toEqual([["payments", false], ["places", true], ["texts", false]]);
    const base = pluginManifestWithFeatures(declared, []);
    expect(base.providers).toEqual([]);
    expect(base.scopes).toEqual(["read_orders"]);
    expect(base.allowedHosts).toEqual(["base.acme.example"]);
    expect(base.events).toEqual(["order.created"]);
    expect(base.routes).toEqual({ admin: [{ name: "home", methods: ["GET"] }], public: [], webhooks: [] });
    expect(base.cron).toEqual([]);
    expect(base.admin.pages.map((page) => page.id)).toEqual(["home"]);
    expect(base.settings.map((field) => field.key)).toEqual(["general"]);
    expect(base.admin.settingsGroups).toEqual([]);
    // The declaration stays for the dashboard.
    expect(base.features).toHaveLength(3);
  });

  it("adds exactly a feature's part when it is on, and is idempotent", () => {
    const declared = parse(PACK);
    const places = pluginManifestWithFeatures(declared, ["places", "unknown"]);
    expect(places.scopes).toEqual(["read_orders", "write_places"]);
    expect(places.cron.map((job) => job.name)).toEqual(["sync"]);
    expect(places.admin.pages.map((page) => page.id)).toEqual(["places", "home"]);
    expect(places.providers).toEqual([]);
    const both = pluginManifestWithFeatures(declared, ["payments", "texts"]);
    expect(both.providers.map((provider) => provider.id)).toEqual(["pay", "sms"]);
    expect(both.allowedHosts).toEqual(["base.acme.example", "pay.example", "sms.example"]);
    expect(both.settings.map((field) => field.key)).toEqual(["general", "pay_key", "sms_token"]);
    expect(both.events).toEqual(["order.paid", "order.created"]);
    expect(pluginManifestWithFeatures(both, ["payments", "texts"])).toEqual(both);
    expect(pluginManifestWithFeatures(declared, declared.features.map((feature) => feature.id)).providers).toHaveLength(2);
  });

  it("grants record the features that are on; turning one on expands, off narrows", () => {
    const declared = parse(PACK);
    const base = pluginGrantRequest(declared);
    expect(base.features).toEqual([]);
    expect(base.scopes).toEqual(["read_orders"]);
    expect(base.providers).toEqual([]);
    expect(base.publicRoutes).toBe(false);
    const payments = pluginGrantRequest(declared, ["payments"]);
    expect(payments).toMatchObject({ features: ["payments"], providers: ["payment"], publicRoutes: true, allowedHosts: ["base.acme.example", "pay.example"] });
    expect(pluginGrantExpands(base, payments)).toBe(true);
    expect(pluginGrantExpands(payments, base)).toBe(false);
    expect(pluginGrantAdditions(base, payments)).toMatchObject({ features: ["payments"], allowedHosts: ["pay.example"], providers: ["payment"] });
    // The running manifest gives the same request for the same features.
    expect(pluginGrantKey(pluginGrantRequest(pluginManifestWithFeatures(declared, ["payments"]), ["payments"]))).toBe(pluginGrantKey(payments));
    // An app without features keeps its grant key (an empty dimension is left out of it).
    const plain = parse({ ...PACK, scopes: ["read_orders", "read_customer_phones"], features: [], translations: undefined });
    expect(pluginGrantRequest(plain).features).toEqual([]);
    expect(pluginGrantKey(pluginGrantRequest(plain))).not.toContain("features");
  });

  it("describes what one feature asks for, without the base", () => {
    const declared = parse(PACK);
    expect(pluginFeatureRequest(declared, "places")).toEqual({
      scopes: ["write_places"], allowedHosts: [], providers: [], events: [], functions: [], publicRoutes: false, storefront: false, admin: true, cron: ["sync"],
    });
    expect(pluginFeatureRequest(declared, "payments")).toMatchObject({
      allowedHosts: ["pay.example"], providers: [{ id: "pay", kind: "payment", name: "Pay" }], events: ["order.paid"], publicRoutes: true,
    });
    expect(pluginFeatureRequest(declared, "nope")).toBeNull();
  });

  it("keeps off features' handlers dormant: required in the module, never live", () => {
    const declared = parse(PACK);
    const running = pluginManifestWithFeatures(declared, ["texts"]);
    const inventory = pluginHandlerInventory(running, declared);
    expect(inventory.providers.map((provider) => provider.id)).toEqual(["sms"]);
    expect(inventory.dormant).toMatchObject({
      events: ["order.paid"], cron: ["sync"], routes: { admin: ["places"], public: [], webhooks: ["pay-callback"] },
    });
    expect(inventory.dormant?.providers.map((provider) => provider.id)).toEqual(["pay"]);
    const handler = () => undefined;
    const module = {
      default: {
        manifest: PACK,
        events: { "order.paid": handler, "order.created": handler },
        cron: { sync: handler },
        routes: { admin: { places: handler, home: handler }, webhooks: { "pay-callback": handler } },
        providers: {
          pay: { kind: "payment", createSession: handler, verifyWebhook: handler, verifyReturn: handler, queryPayment: handler },
          sms: { kind: "sms", send: handler },
        },
      },
    };
    const full = checkPluginHandlers(pluginHandlerInventory(declared), module);
    expect(checkPluginHandlers(inventory, module)).toEqual(full);
    expect(pluginHandlerInventory(declared, declared).dormant).toBeUndefined();
  });

  it("refuses features that claim undeclared or shared items, repeat base access, or reach into another feature", () => {
    expect(issues({ ...PACK, features: [{ id: "x", name: "X", description: "X.", providers: ["missing"] }] }))
      .toContain("features.0.providers.0: Provider missing is not declared.");
    expect(issues({ ...PACK, features: [
      { id: "a", name: "A", description: "A.", cron: ["sync"] },
      { id: "b", name: "B", description: "B.", cron: ["sync"] },
    ] })).toContain("features.1.cron.0: Cron job sync already belongs to feature a.");
    expect(issues({ ...PACK, features: [{ id: "a", name: "A", description: "A.", scopes: ["read_orders"] }] }))
      .toContain("features.0.scopes.0: read_orders is already a base scope of the app.");
    // A base page drawn by a feature's route would break while the feature is off.
    expect(issues({ ...PACK, features: [{ id: "a", name: "A", description: "A.", routes: { admin: ["home"] } }] }))
      .toContain("admin.pages.1.route: Admin route home belongs to feature a, but this belongs to the base.");
    // A feature's admin route may use the feature's own scope.
    expect(issues({
      ...PACK,
      routes: { ...PACK.routes, admin: [{ name: "places", methods: ["GET"], scope: "write_places" }, { name: "home", methods: ["GET"] }] },
    })).toEqual([]);
    expect(issues({ ...PACK, translations: { bn: { features: { ghost: { name: "ভূত" } } } } }))
      .toContain("translations.bn.features.ghost: No feature ghost to translate.");
    expect(issues({ ...PACK, features: [...PACK.features!, { ...PACK.features![0]!, id: "payments" }] })).toContain("features: Feature ids must be unique.");
  });
});
