import { describe, expect, it } from "vitest";
import { EVENTS_API_VERSION } from "../events";
import {
  PLUGIN_API_VERSION,
  PLUGIN_FUNCTION_POINTS,
  PLUGIN_FUNCTION_SCHEMAS,
  parsePluginManifest,
  pluginGrantExpands,
  pluginGrantKey,
  pluginGrantRequest,
  pluginSettingDefaults,
  validatePluginSettingValues,
  type PluginManifestInput,
} from "../plugins";

/** A plugin that uses every extension point. */
const FULL: PluginManifestInput = {
  id: "acme.loyalty",
  name: "Acme Loyalty",
  version: "1.2.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Points for every order, redeemable at checkout.",
  author: { name: "Acme", url: "https://acme.example" },
  permissions: ["orders.view", "customers.view"],
  allowedHosts: ["api.acme.example", "*.cdn.acme.example"],
  events: ["order.paid", "order.refunded"],
  functions: [{ point: "checkout.discounts" }],
  providers: [{ kind: "messaging", id: "acme-sms", name: "Acme SMS" }],
  routes: {
    admin: [{ name: "dashboard", methods: ["GET"] }, { name: "adjust", methods: ["POST"] }],
    public: [{ name: "balance", methods: ["GET"] }],
    webhooks: ["acme-callback"],
  },
  cron: [{ name: "expire-points", schedule: "0 3 * * *" }],
  storage: { ledger: { indexes: ["customerId", ["customerId", "createdAt"]], unique: [] } },
  customFields: [{ ownerType: "customer", key: "points", name: "Points", type: "integer" }],
  settings: [
    { key: "points_per_taka", label: "Points per taka", type: "number", default: 1, min: 0, max: 100 },
    { key: "api_key", label: "API key", type: "secret", required: true },
    { key: "tier", label: "Tier", type: "select", options: [{ value: "gold", label: "Gold" }], default: "gold" },
  ],
  admin: {
    pages: [{ id: "overview", title: "Loyalty", route: "dashboard" }],
    cards: [{ id: "customer-points", target: "customer", title: "Points", route: "dashboard" }],
    actions: [{ id: "grant", target: "customer", label: "Grant points", route: "adjust" }],
  },
  storefront: {
    sections: [{ type: "points-banner", name: "Points banner", route: "balance" }],
    scripts: [{ src: "https://cdn.acme.example/widget.js" }],
    proxy: true,
  },
};

describe("plugin manifest", () => {
  it("versions the plugin API with the event catalog", () => {
    expect(PLUGIN_API_VERSION).toBe(EVENTS_API_VERSION);
  });

  it("accepts a manifest using every extension point and fills defaults", () => {
    const result = parsePluginManifest(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.functions[0]).toEqual({ point: "checkout.discounts", priority: 100 });
    expect(result.manifest.limits).toEqual({ cpuMs: 50, wallMs: 10_000 });
    expect(result.manifest.storefront.scripts[0]!.placement).toBe("body-end");
  });

  it.each([
    ["an id without a vendor", { id: "loyalty" }, "id"],
    ["an unknown api version", { apiVersion: "2020-01" }, "apiVersion"],
    ["a non-semver version", { version: "1.2" }, "version"],
    ["an unknown event", { events: ["order.exploded"] }, "events.0"],
    ["an IP host", { allowedHosts: ["10.0.0.1"] }, "allowedHosts.0"],
    ["localhost", { allowedHosts: ["localhost"] }, "allowedHosts.0"],
    ["a wildcard with a port", { allowedHosts: ["*.acme.example:8443"] }, "allowedHosts.0"],
    ["a port out of range", { allowedHosts: ["api.acme.example:70000"] }, "allowedHosts.0"],
    ["an http script", { storefront: { scripts: [{ src: "http://cdn.acme.example/w.js" }] } }, "storefront.scripts.0.src"],
    ["a page whose route is missing", { admin: { pages: [{ id: "p", title: "P", route: "nope" }] } }, "admin.pages.0.route"],
    ["a section on an admin route", { storefront: { sections: [{ type: "s", name: "S", route: "dashboard" }] } }, "storefront.sections.0.route"],
    ["an unknown key", { extra: true }, "(root)"],
  ])("rejects %s", (_label, override, path) => {
    const result = parsePluginManifest({ ...FULL, ...override });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it("asks for approval again only when an update widens the grant", () => {
    const parse = (input: PluginManifestInput) => {
      const result = parsePluginManifest(input);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return pluginGrantRequest(result.manifest);
    };
    const granted = parse({ ...FULL, events: ["order.*"] });
    // A covered exact topic, the same grant reordered, or fewer permissions: no new approval.
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.paid"] }))).toBe(false);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], permissions: ["customers.view", "orders.view"] }))).toBe(false);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], permissions: ["orders.view"] }))).toBe(false);
    // New data, hosts, topics or scripts need approval.
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], permissions: ["orders.view", "orders.edit"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*", "product.created"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["*"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], allowedHosts: ["api.other.example"] }))).toBe(true);
    // The key is order-independent.
    expect(pluginGrantKey(parse({ ...FULL, permissions: ["customers.view", "orders.view"] })))
      .toBe(pluginGrantKey(parse({ ...FULL, permissions: ["orders.view", "customers.view"] })));
  });
});

describe("plugin settings", () => {
  const parsed = parsePluginManifest(FULL);
  if (!parsed.ok) throw new Error("fixture");
  const schema = parsed.manifest.settings;

  it("starts from the declared defaults, never a secret", () => {
    expect(pluginSettingDefaults(schema)).toEqual({ points_per_taka: 1, tier: "gold" });
  });

  it("validates writes: required, ranges, options, unknown keys, kept secrets", () => {
    expect(validatePluginSettingValues(schema, { points_per_taka: 2, api_key: "k" })).toEqual({ ok: true, values: { points_per_taka: 2, api_key: "k" } });
    // Omitting a stored secret keeps it; clearing a required one fails.
    expect(validatePluginSettingValues(schema, { points_per_taka: 2 }, new Set(["api_key"])).ok).toBe(true);
    expect(validatePluginSettingValues(schema, { api_key: null }, new Set(["api_key"])).ok).toBe(false);
    const bad = validatePluginSettingValues(schema, { points_per_taka: 101, api_key: "k", tier: "platinum", other: 1 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.map((error) => error.key).sort()).toEqual(["other", "points_per_taka", "tier"]);
  });
});

describe("storefront surfaces in the manifest", () => {
  const base = {
    ...FULL,
    routes: { admin: [], public: [{ name: "draw", methods: ["GET"] }], webhooks: [] },
    storage: { reviews: { indexes: ["productId"] } },
    customFields: [],
    admin: { pages: [], cards: [], actions: [], widgets: [] },
  } satisfies PluginManifestInput;
  const section = (extra: Record<string, unknown> = {}) => ({ type: "latest", name: "Latest", route: "draw", ...extra });
  const issues = (input: unknown) => {
    const parsed = parsePluginManifest(input);
    return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path} ${issue.message}`);
  };

  it("declares what a section reads, from declared collections only", () => {
    const parsed = parsePluginManifest({ ...base, storefront: { sections: [section({ reads: ["reviews"] })] } });
    expect(parsed.ok && parsed.manifest.storefront.sections[0]!.reads).toEqual(["reviews"]);
    // Nothing declared: the output depends on settings alone.
    const none = parsePluginManifest({ ...base, storefront: { productBlocks: [{ type: "stars", name: "Stars", placement: "buy-box", route: "draw" }] } });
    expect(none.ok && none.manifest.storefront.productBlocks[0]!.reads).toEqual([]);
    expect(issues({ ...base, storefront: { sections: [section({ reads: ["ledger"] })] } }))
      .toEqual(["storefront.sections.0.reads.0 Storage collection ledger is not declared."]);
  });

  it("keeps storefront settings public: no secrets", () => {
    expect(issues({ ...base, storefront: { sections: [section({ settings: [{ key: "token", label: "Token", type: "secret" }] })] } }))
      .toEqual(["storefront.sections.0.settings.0.type Storefront settings are public: keep secrets in the app's settings."]);
  });

  it("needs unique product block types and a declared public route", () => {
    const block = { type: "stars", name: "Stars", placement: "below", route: "draw" } as const;
    expect(issues({ ...base, storefront: { productBlocks: [block, block] } })).toEqual(["storefront.productBlocks Product block types must be unique."]);
    expect(issues({ ...base, storefront: { productBlocks: [{ ...block, route: "missing" }] } })).toEqual(["storefront.productBlocks.0.route Public route missing is not declared."]);
  });
});

describe("plugin functions", () => {
  it("declares an input and output schema for every function point", () => {
    expect(Object.keys(PLUGIN_FUNCTION_SCHEMAS).sort()).toEqual([...PLUGIN_FUNCTION_POINTS].sort());
  });

  it("keeps discounts in minor units and rejects a negative or fractional amount", () => {
    const output = PLUGIN_FUNCTION_SCHEMAS["checkout.discounts"].output;
    const discount = (amountMinor: number) => ({ discounts: [{ title: "Points", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor } }] });
    expect(output.safeParse(discount(5000)).success).toBe(true);
    expect(output.safeParse(discount(-1)).success).toBe(false);
    expect(output.safeParse(discount(12.5)).success).toBe(false);
  });
});
