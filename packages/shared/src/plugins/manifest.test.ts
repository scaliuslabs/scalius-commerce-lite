import { describe, expect, it } from "vitest";
import { EVENTS_API_VERSION } from "../events";
import {
  PLUGIN_API_VERSION,
  SCALIUS_PLATFORM_VERSION,
  PLUGIN_FUNCTION_POINTS,
  PLUGIN_FUNCTION_SCHEMAS,
  parsePluginManifest,
  pluginCompatibility,
  PLUGIN_GRANT_FLAG_DIMENSIONS,
  PLUGIN_GRANT_LIST_DIMENSIONS,
  emptyPluginGrantRequest,
  pluginGrantExpands,
  pluginGrantKey,
  pluginGrantRequest,
  pluginSettingDefaults,
  validatePluginSettingValues,
  appSettingsSections,
  appWideSettingKeys,
  providerOwnSettingKeys,
  providerSettingKeys,
  qualifiedSettingLabel,
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
  scopes: ["read_orders", "read_customers", "read_customer_phones"],
  allowedHosts: ["api.acme.example", "*.cdn.acme.example"],
  events: ["order.paid", "order.refunded"],
  functions: [{ point: "checkout.discounts" }],
  providers: [{ kind: "messaging", id: "acme-sms", name: "Acme SMS" }],
  routes: {
    admin: [{ name: "dashboard", methods: ["GET"] }, { name: "adjust", methods: ["POST"] }],
    public: [{ name: "balance", methods: ["GET"] }],
    webhooks: [{ name: "acme-callback" }],
  },
  cron: [{ name: "expire_points", schedule: "0 3 * * *" }],
  objects: { ledger: {
    name: "Ledger",
    fields: [
      { key: "customer_id", name: "Customer", type: "single_line_text" },
      { key: "created_at", name: "Created at", type: "integer" },
    ],
    indexes: ["customer_id", ["customer_id", "created_at"]],
    unique: [],
  } },
  customFields: [{ ownerType: "customer", key: "points", name: "Points", type: "integer" }],
  settings: [
    { key: "points_per_taka", label: "Points per taka", type: "number", default: 1, min: 0, max: 100 },
    { key: "api_key", label: "API key", type: "secret", required: true },
    { key: "tier", label: "Tier", type: "select", options: [{ value: "gold", label: "Gold" }], default: "gold" },
  ],
  admin: {
    pages: [{ id: "overview", title: "Loyalty", route: "dashboard" }],
    cards: [{ id: "customer_points", target: "customer", title: "Points", route: "dashboard" }],
    actions: [{ id: "grant", target: "customer", label: "Grant points", route: "adjust" }],
  },
  storefront: {
    sections: [{ type: "points_banner", name: "Points banner" }],
    scripts: [{ src: "https://cdn.acme.example/widget.js" }],
    proxy: true,
  },
};

describe("plugin manifest", () => {
  it("requires an exact qualified target for Object custom fields", () => {
    const field = { ownerType: "product", key: "size_chart", name: "Size chart", type: "object_reference", to: "acme.loyalty.size_chart" };
    expect(parsePluginManifest({ ...FULL, customFields: [field] }).ok).toBe(true);
    expect(parsePluginManifest({ ...FULL, customFields: [{ ...field, type: "list.object_reference" }] }).ok).toBe(true);
    for (const to of [undefined, "size_chart", "custom.SizeChart"]) {
      expect(parsePluginManifest({ ...FULL, customFields: [{ ...field, to }] }).ok).toBe(false);
    }
    expect(parsePluginManifest({ ...FULL, customFields: [{ ...field, type: "single_line_text" }] }).ok).toBe(false);
  });
  it("gates real-staff admin routes with one of the app's own scopes, on admin routes only", () => {
    const route = { name: "adjust", methods: ["POST"], scope: "write_marketing" };
    const manifest = { ...FULL, scopes: [...FULL.scopes!, "write_marketing"], routes: { ...FULL.routes, admin: [...FULL.routes!.admin!.filter((item) => item.name !== "adjust"), route] } };
    const parsed = parsePluginManifest(manifest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.routes.admin.find((item) => item.name === "adjust")?.scope).toBe("write_marketing");
    expect(parsePluginManifest({ ...manifest, scopes: FULL.scopes }).ok).toBe(false);
    expect(parsePluginManifest({ ...FULL, routes: { ...FULL.routes, public: [{ name: "balance", methods: ["GET"], scope: "read_customers" }] } }).ok).toBe(false);
  });

  it("takes access scopes, never raw RBAC permission names", () => {
    expect(parsePluginManifest({ ...FULL, scopes: ["orders.view"] }).ok).toBe(false);
    expect(parsePluginManifest({ ...FULL, scopes: ["read_orders", "read_orders"] }).ok).toBe(false);
    expect(parsePluginManifest({ ...FULL, scopes: undefined, permissions: ["orders.view"] }).ok).toBe(false);
  });

  it("translates only declared select and multiselect values, leaving stored defaults unchanged", () => {
    const translations = { bn: { settings: { tier: { options: { gold: "সোনালি" } } } } };
    const parsed = parsePluginManifest({ ...FULL, translations });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.translations?.bn?.settings?.tier?.options).toEqual({ gold: "সোনালি" });
      expect(parsed.manifest.settings.find((field) => field.key === "tier")).toMatchObject({ type: "select", default: "gold" });
    }
    expect(parsePluginManifest({ ...FULL, settings: [{ key: "tier", label: "Tiers", type: "multiselect", options: [{ value: "gold", label: "Gold" }] }], translations }).ok).toBe(true);
    expect(parsePluginManifest({ ...FULL, translations: { bn: { settings: { tier: { options: { missing: "X" } } } } } }).ok).toBe(false);
    expect(parsePluginManifest({ ...FULL, translations: { bn: { settings: { api_key: { options: {} } } } } }).ok).toBe(false);
    expect(parsePluginManifest({ ...FULL, translations: { bn: { settings: { tier: { options: { gold: " " } } } } } }).ok).toBe(false);
  });

  it("versions the plugin API with the event catalog", () => {
    expect(PLUGIN_API_VERSION).toBe(EVENTS_API_VERSION);
  });

  it("takes data updates in increasing version order only", () => {
    const ok = parsePluginManifest({ ...FULL, migrations: [{ version: 1, description: "Seed" }, { version: 3, description: "Backfill" }] });
    expect(ok.ok).toBe(true);
    const backwards = parsePluginManifest({ ...FULL, migrations: [{ version: 2, description: "B" }, { version: 2, description: "Again" }] });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.issues[0]).toMatchObject({ path: "migrations.1.version" });
  });

  it("says plainly when this platform cannot run a manifest", () => {
    expect(pluginCompatibility(FULL)).toEqual({ ok: true });
    expect(pluginCompatibility({ ...FULL, apiVersion: "2025-01" })).toMatchObject({ ok: false, reason: "api_version" });
    expect(pluginCompatibility({ ...FULL, minPlatformVersion: "99.0.0" }))
      .toMatchObject({ ok: false, reason: "platform_version", message: expect.stringMatching(/Needs Scalius 99.0.0/) });
    expect(pluginCompatibility({ ...FULL, minPlatformVersion: "0.1.0" })).toEqual({ ok: true });
  });

  it("accepts a manifest using every extension point and fills defaults", () => {
    const result = parsePluginManifest(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.functions[0]).toEqual({ point: "checkout.discounts", priority: 100, onError: "skip", reads: [] });
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
    ["a script on cart", { storefront: { scripts: [{ src: "https://cdn.acme.example/w.js", pages: ["cart"] }] } }, "storefront.scripts.0.pages.0"],
    ["a script on checkout", { storefront: { scripts: [{ src: "https://cdn.acme.example/w.js", pages: ["checkout"] }] } }, "storefront.scripts.0.pages.0"],
    ["a script on the order receipt", { storefront: { scripts: [{ src: "https://cdn.acme.example/w.js", pages: ["order-success"] }] } }, "storefront.scripts.0.pages.0"],
    ["a page whose route is missing", { admin: { pages: [{ id: "p", title: "P", route: "nope" }] } }, "admin.pages.0.route"],
    ["a section with a route (sections are components)", { storefront: { sections: [{ type: "s", name: "S", route: "dashboard" }] } }, "storefront.sections.0"],
    ["an unknown key", { extra: true }, "(root)"],
    ["a translation of a page it doesn't have", { translations: { bn: { pages: { missing: "পাতা" } } } }, "translations.bn.pages.missing"],
    ["a translation under a malformed language tag", { translations: { "pt_BR": { name: "Fidelidade" } } }, "translations.pt_BR"],
    ["a translation under an uppercase language", { translations: { FR: { name: "Fidélité" } } }, "translations.FR"],
    ["a translation of a page in another language it doesn't have", { translations: { fr: { pages: { missing: "Page" } } } }, "translations.fr.pages.missing"],
    ["twenty-one translations", { translations: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`a${String.fromCharCode(97 + index)}`, { name: "X" }])) }, "translations"],
    ["a discount that blocks checkout", { functions: [{ point: "checkout.discounts", onError: "block" }] }, "functions.0.onError"],
    ["a retired snapshot (reads replace it)", { functions: [{ point: "checkout.discounts", snapshot: { object: "ledger" } }] }, "functions.0"],
    ["a read of an undeclared object", { functions: [{ point: "checkout.discounts", reads: [{ as: "x", object: "nope", key: "customer" }] }] }, "functions.0.reads.0.object"],
    ["an object named batch", { objects: { batch: { name: "Batch", fields: [{ key: "value", name: "Value", type: "integer" }] } } }, "objects.batch"],
    ["an icon outside the plugin", { icon: "../secret.svg" }, "icon"],
    ["a JPEG icon", { icon: "assets/icon.jpg" }, "icon"],
    ["an SVG screenshot", { screenshots: ["assets/one.svg"] }, "screenshots.0"],
    ["seven screenshots", { screenshots: [1, 2, 3, 4, 5, 6, 7].map((n) => `shots/${n}.png`) }, "screenshots"],
    ["an unknown category", { categories: ["games"] }, "categories.0"],
    ["four categories", { categories: ["payments", "orders", "checkout", "finances"] }, "categories"],
    ["a repeated category", { categories: ["payments", "payments"] }, "categories"],
    ["a lowercase country", { countries: ["bd"] }, "countries.0"],
    ["an empty support block", { support: {} }, "support"],
    ["an http privacy policy", { privacyPolicyUrl: "http://acme.example/privacy" }, "privacyPolicyUrl"],
    ["a newer platform", { minPlatformVersion: "99.0.0" }, "minPlatformVersion"],
  ])("rejects %s", (_label, override, path) => {
    const result = parsePluginManifest({ ...FULL, ...override });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it("carries the listing: icon, tagline, categories, screenshots, links, countries and platform floor", () => {
    const result = parsePluginManifest({
      ...FULL,
      icon: "assets/icon.svg",
      tagline: "Points that bring buyers back",
      categories: ["loyalty", "marketing"],
      screenshots: ["assets/screens/points.png", "assets/screens/redeem.webp"],
      support: { url: "https://acme.example/help", email: "help@acme.example" },
      privacyPolicyUrl: "https://acme.example/privacy",
      documentationUrl: "https://acme.example/docs",
      changelogUrl: "https://acme.example/changes",
      countries: ["BD", "IN"],
      minPlatformVersion: SCALIUS_PLATFORM_VERSION,
      translations: { bn: { name: "অ্যাকমি লয়্যালটি", tagline: "ক্রেতা ফিরিয়ে আনার পয়েন্ট" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({ icon: "assets/icon.svg", categories: ["loyalty", "marketing"], countries: ["BD", "IN"] });
    expect(result.manifest.translations?.bn?.tagline).toBe("ক্রেতা ফিরিয়ে আনার পয়েন্ট");
    // Left out: no categories or screenshots, every country.
    const bare = parsePluginManifest(FULL);
    expect(bare.ok && [bare.manifest.categories, bare.manifest.screenshots, bare.manifest.countries]).toEqual([[], [], undefined]);
  });

  it("names the platform release the root package is", async () => {
    const specifier = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ specifier)) as { readFile(path: URL, encoding: "utf8"): Promise<string> };
    const pkg = JSON.parse(await fs.readFile(new URL("../../../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SCALIUS_PLATFORM_VERSION).toBe(pkg.version);
  });

  it("carries Bangla text for the dashboard, optional and per surface", () => {
    const result = parsePluginManifest({
      ...FULL,
      translations: { bn: { name: "অ্যাকমি লয়্যালটি", description: "প্রতিটি অর্ডারে পয়েন্ট।", pages: { overview: "লয়্যালটি" }, actions: { grant: "পয়েন্ট দিন" } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.translations?.bn).toMatchObject({ name: "অ্যাকমি লয়্যালটি", pages: { overview: "লয়্যালটি" } });
    // Without translations the manifest is English only.
    const english = parsePluginManifest(FULL);
    expect(english.ok && english.manifest.translations).toBeUndefined();
  });

  it("takes a translation under any BCP 47 language tag, up to twenty", () => {
    const tags = ["fr", "pt-BR", "zh-Hant-TW", "es-419", "fil"];
    const result = parsePluginManifest({ ...FULL, translations: Object.fromEntries(tags.map((tag) => [tag, { name: `Name ${tag}` }])) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.manifest.translations ?? {})).toEqual(tags);
    const twenty = parsePluginManifest({ ...FULL, translations: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`a${String.fromCharCode(97 + index)}`, { name: "X" }])) });
    expect(twenty.ok).toBe(true);
  });

  it("asks for approval again only when an update widens the grant", () => {
    const parse = (input: PluginManifestInput) => {
      const result = parsePluginManifest(input);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return pluginGrantRequest(result.manifest);
    };
    const granted = parse({ ...FULL, events: ["order.*"] });
    // A covered exact topic, the same grant reordered, or fewer scopes: no new approval.
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.paid"] }))).toBe(false);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], scopes: ["read_customers", "read_orders", "read_customer_phones"] }))).toBe(false);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], scopes: ["read_orders", "read_customer_phones"] }))).toBe(false);
    // New data, hosts, topics or scripts need approval.
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], scopes: ["read_orders", "write_orders", "read_customer_phones"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*", "product.created"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["*"] }))).toBe(true);
    expect(pluginGrantExpands(granted, parse({ ...FULL, events: ["order.*"], allowedHosts: ["api.other.example"] }))).toBe(true);
    // Pausing checkout on failure is a new power: the same point with onError "block" needs approval.
    const validating = parse({ ...FULL, events: ["order.*"], functions: [{ point: "cart.validate" }] });
    const blocking = parse({ ...FULL, events: ["order.*"], functions: [{ point: "cart.validate", onError: "block" }] });
    expect(blocking.blockingFunctions).toEqual(["cart.validate"]);
    expect(pluginGrantExpands(validating, blocking)).toBe(true);
    expect(pluginGrantExpands(blocking, validating)).toBe(false);
    // The key is order-independent.
    expect(pluginGrantKey(parse({ ...FULL, scopes: ["read_customers", "read_orders", "read_customer_phones"] })))
      .toBe(pluginGrantKey(parse({ ...FULL, scopes: ["read_orders", "read_customers", "read_customer_phones"] })));
  });

  it("keys a grant canonically, versioned, with defaults left out so new dimensions are additive", () => {
    const request = { ...emptyPluginGrantRequest(), scopes: ["read_orders" as const], publicRoutes: true, allowedHosts: ["b.example", "a.example", "a.example"] };
    expect(pluginGrantKey(request)).toBe('g1:{"allowedHosts":["a.example","b.example"],"publicRoutes":true,"scopes":["read_orders"]}');
    // Key order of the object never matters.
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    expect(pluginGrantKey(reordered)).toBe(pluginGrantKey(request));
    // A dimension added later at its default (an unknown key here) changes nothing.
    expect(pluginGrantKey({ ...request, storefrontConnect: [], features: [], storefrontCode: false })).toBe(pluginGrantKey(request));
    expect(pluginGrantKey(emptyPluginGrantRequest())).toBe("g1:{}");
    // Every dimension the request carries is keyed (none is silently ignored).
    for (const dimension of [...PLUGIN_GRANT_LIST_DIMENSIONS, ...PLUGIN_GRANT_FLAG_DIMENSIONS]) {
      expect(Object.keys(emptyPluginGrantRequest())).toContain(dimension);
    }
    expect(Object.keys(emptyPluginGrantRequest()).sort()).toEqual([...PLUGIN_GRANT_LIST_DIMENSIONS, ...PLUGIN_GRANT_FLAG_DIMENSIONS].sort());
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
    objects: { reviews: { name: "Reviews", fields: [{ key: "product_id", name: "Product", type: "single_line_text" }], indexes: ["product_id"] } },
    customFields: [],
    admin: { pages: [], cards: [], actions: [], widgets: [] },
  } satisfies PluginManifestInput;
  const section = (extra: Record<string, unknown> = {}) => ({ type: "latest", name: "Latest", ...extra });
  const issues = (input: unknown) => {
    const parsed = parsePluginManifest(input);
    return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path} ${issue.message}`);
  };

  it("declares sections and components: no route, no storage reads", () => {
    expect(parsePluginManifest({ ...base, storefront: { sections: [section()] } }).ok).toBe(true);
    expect(issues({ ...base, storefront: { sections: [section({ route: "draw" })] } })).toHaveLength(1);
    expect(issues({ ...base, storefront: { sections: [section({ reads: ["reviews"] })] } })).toHaveLength(1);
    expect(issues({ ...base, storefront: { components: [{ type: "stars", name: "Stars", targets: ["product.buy_box.after"], route: "draw" } as never] } })).toHaveLength(1);
  });

  it("keeps storefront settings public: no secrets", () => {
    expect(issues({ ...base, storefront: { sections: [section({ settings: [{ key: "token", label: "Token", type: "secret" }] })] } }))
      .toEqual(["storefront.sections.0.settings.0.type Storefront settings are public: keep secrets in the app's settings."]);
  });

  it("needs unique component types", () => {
    const component = { type: "stars", name: "Stars", targets: ["product.below"] as const };
    expect(issues({ ...base, storefront: { components: [{ ...component, targets: [...component.targets] }, { ...component, targets: [...component.targets] }] } })).toEqual(["storefront.components Component types must be unique."]);
  });

  it("rejects retired route-rendered buyer blocks", () => {
    const manifest = { id: "acme.notes", name: "Notes", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Buyer notes", author: { name: "Acme" } };
    const block = { type: "note", name: "Note", target: "checkout.contact.after", route: "draw" };
    expect(parsePluginManifest(manifest).ok).toBe(true);
    expect(parsePluginManifest({ ...manifest, storefront: { blocks: [block] } }).ok).toBe(false);
    expect(parsePluginManifest({ ...manifest, features: [{ id: "notes", name: "Notes", description: "Buyer notes", storefront: { blocks: ["note"] } }] }).ok).toBe(false);
  });
});

describe("settings groups and page tabs in the manifest", () => {
  const issues = (input: unknown) => {
    const parsed = parsePluginManifest(input);
    return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path} ${issue.message}`);
  };
  const pack = {
    ...FULL,
    scopes: ["read_orders", "read_customers", "read_customer_names", "read_customer_phones", "read_customer_addresses"],
    providers: { sms: [{ id: "alpha", name: "Alpha", settings: ["alpha_key"] }], courier: [{ id: "beta", name: "Beta" }] },
    settings: [
      { key: "store_code", label: "Store code", type: "text", group: "store" },
      { key: "region", label: "Region", type: "text" },
      { key: "alpha_key", label: "API key", type: "secret" },
      { key: "alpha_sender", label: "Sender", type: "text", group: "alpha" },
      { key: "beta_token", label: "Token", type: "secret", group: "beta" },
    ],
    admin: {
      settingsGroups: [
        { id: "store", title: "Store", description: "How the app names your store.", order: 50 },
        { id: "extras", title: "Extras" },
      ],
    },
  } satisfies PluginManifestInput;

  it("puts provider fields with their provider and app-wide ones in their sections", () => {
    const parsed = parsePluginManifest(pack);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const { manifest } = parsed;
    expect(manifest.admin.settingsGroups.map((group) => [group.id, group.order])).toEqual([["store", 50], ["extras", 100]]);
    expect(providerOwnSettingKeys(manifest, "alpha")).toEqual(["alpha_key", "alpha_sender"]);
    expect(providerOwnSettingKeys(manifest, "beta")).toEqual(["beta_token"]);
    expect(appWideSettingKeys(manifest)).toEqual(["store_code", "region"]);
    // An empty group is left out; the ungrouped fields come first.
    expect(appSettingsSections(manifest)).toEqual([
      { group: null, keys: ["region"] },
      { group: { id: "store", title: "Store", description: "How the app names your store." }, keys: ["store_code"] },
    ]);
    expect(qualifiedSettingLabel(manifest, "alpha_key")).toBe("Alpha: API key");
    expect(qualifiedSettingLabel(manifest, "region")).toBe("Region");
  });

  it("gives a provider without fields of its own the app's general settings", () => {
    const single = parsePluginManifest({
      ...FULL,
      providers: { payment: [{ id: "pay", name: "Pay", chargeCurrencies: ["BDT"], operations: ["verifyReturn", "queryPayment"] }] },
    });
    if (!single.ok) throw new Error(JSON.stringify(single.issues));
    expect(providerOwnSettingKeys(single.manifest, "pay")).toEqual([]);
    expect(providerSettingKeys(single.manifest, "pay")).toEqual(["points_per_taka", "api_key", "tier"]);
  });

  it("refuses a group that names nothing, a group named like a provider and groups on storefront settings", () => {
    expect(issues({ ...pack, settings: [...pack.settings, { key: "x", label: "X", type: "text", group: "nowhere" }] }))
      .toEqual(["settings.5.group Group nowhere is neither a settings group nor a provider id."]);
    expect(issues({ ...pack, admin: { settingsGroups: [{ id: "alpha", title: "Alpha" }] } }))
      .toContain('admin.settingsGroups.0.id alpha is a provider id: provider fields join their provider with group: "alpha".');
    expect(issues({ ...pack, admin: { settingsGroups: [{ id: "store", title: "A" }, { id: "store", title: "B" }] } }))
      .toContain("admin.settingsGroups Settings group ids must be unique.");
    // The sections are a dashboard surface: only under admin.
    expect(issues({ ...pack, settingsGroups: [{ id: "store", title: "Store" }] }).length).toBeGreaterThan(0);
    expect(issues({
      ...pack,
      routes: { ...FULL.routes, public: [{ name: "draw", methods: ["GET"] }] },
      storefront: { sections: [{ type: "s", name: "S", settings: [{ key: "a", label: "A", type: "text", group: "store" }] }] },
    })).toEqual(["storefront.sections.0.settings.0.group Groups are for the app's own settings."]);
  });

  it("draws a page's tabs from declared routes, one of them the page's own", () => {
    const tabs = [{ id: "summary", title: "Summary", route: "dashboard" }, { id: "adjust", title: "Adjust", route: "adjust" }];
    const page = { id: "overview", title: "Loyalty", route: "dashboard", tabs };
    const parsed = parsePluginManifest({ ...FULL, admin: { ...FULL.admin, pages: [page] } });
    expect(parsed.ok && parsed.manifest.admin.pages[0]!.tabs).toEqual(tabs);
    expect(issues({ ...FULL, admin: { ...FULL.admin, pages: [{ ...page, route: "other" }] } })).toContain("admin.pages.0.route Admin route other is not declared.");
    expect(issues({ ...FULL, admin: { ...FULL.admin, pages: [{ ...page, tabs: [tabs[1], { ...tabs[1], id: "more" }] }] } }))
      .toEqual(["admin.pages.0.route A page with tabs draws one of them: use a tab's route."]);
    expect(issues({ ...FULL, admin: { ...FULL.admin, pages: [{ ...page, tabs: [tabs[0], { ...tabs[1], id: "summary" }] }] } }))
      .toEqual(["admin.pages.0.tabs Tab ids must be unique."]);
    expect(issues({ ...FULL, admin: { ...FULL.admin, pages: [{ ...page, tabs: [{ ...tabs[1], route: "missing" }, tabs[0]] }] } }))
      .toEqual(["admin.pages.0.tabs.0.route Admin route missing is not declared."]);
  });

  it("translates group titles, tab titles and setting labels it declares, and nothing else", () => {
    const tabs = [{ id: "summary", title: "Summary", route: "dashboard" }, { id: "adjust", title: "Adjust", route: "adjust" }];
    const withTabs = { ...pack, admin: { ...FULL.admin, ...pack.admin, pages: [{ id: "overview", title: "Loyalty", route: "dashboard", tabs }] } };
    const bn = { tabs: { overview: { summary: "সারসংক্ষেপ" } }, settingsGroups: { store: { title: "স্টোর" } }, settings: { alpha_key: { label: "এপিআই কী" } } };
    expect(issues({ ...withTabs, translations: { bn } })).toEqual([]);
    expect(issues({ ...withTabs, translations: { bn: { tabs: { overview: { nope: "x" } }, settingsGroups: { nope: { title: "x" } }, settings: { nope: { label: "x" } } } } })).toEqual([
      "translations.bn.tabs.overview.nope No tab nope on page overview to translate.",
      "translations.bn.settingsGroups.nope No settings group nope to translate.",
      "translations.bn.settings.nope No setting nope to translate.",
    ]);
  });
});

describe("plugin functions", () => {
  it("declares an input and output schema for every function point", () => {
    expect(Object.keys(PLUGIN_FUNCTION_SCHEMAS).sort()).toEqual([...PLUGIN_FUNCTION_POINTS].sort());
  });

  it("lets cart.transform and cart.line_prices block, and every point declare reads", () => {
    const withFunctions = (functions: PluginManifestInput["functions"]) => parsePluginManifest({ ...FULL, functions });
    expect(withFunctions([{ point: "cart.transform", onError: "block" }, { point: "cart.line_prices", onError: "block", reads: [{ as: "ledger", object: "ledger", key: "customer" }] }]).ok).toBe(true);
    expect(withFunctions([{ point: "checkout.shipping_rates", onError: "block" }]).ok).toBe(false);
    expect(withFunctions([{ point: "cart.transform", reads: [{ as: "ledger", object: "ledger", key: "line.variantId", max: 20 }] }]).ok).toBe(true);
    expect(withFunctions([{ point: "cart.transform", snapshot: { object: "ledger" } } as never]).ok).toBe(false);
    const prices = PLUGIN_FUNCTION_SCHEMAS["cart.line_prices"].output;
    expect(prices.safeParse({ prices: [{ lineId: "cart:0:v", unitPriceMinor: 0 }] }).success).toBe(false);
    expect(prices.safeParse({ prices: [{ lineId: "cart:0:v", unitPriceMinor: 12.5 }] }).success).toBe(false);
    const transform = PLUGIN_FUNCTION_SCHEMAS["cart.transform"].output;
    expect(transform.safeParse({ operations: [{ op: "expand", lineId: "cart:0:v", components: [] }] }).success).toBe(false);
    expect(transform.safeParse({ operations: [{ op: "merge", lineIds: ["cart:0:v"], title: "Set" }] }).success).toBe(false);
  });

  it("checks declared reads against the app's objects, custom fields and attributes", () => {
    const manifest = {
      ...FULL,
      checkout: { attributes: [{ key: "company", label: "Company", type: "text" as const }] },
      customFields: [{ ownerType: "customer" as const, key: "points", name: "Points", type: "integer" }, { ownerType: "product" as const, key: "min_qty", name: "Minimum", type: "integer" }],
      objects: {
        ...FULL.objects,
        members: { name: "Members", fields: [{ key: "company_id", name: "Company", type: "object_reference" as const, to: "acme.loyalty.companies" }, { key: "note", name: "Note", type: "integer" as const }] },
        companies: { name: "Companies", fields: [{ key: "name", name: "Name", type: "single_line_text" as const }] },
      },
    };
    const issues = (reads: unknown) => {
      const parsed = parsePluginManifest({ ...manifest, functions: [{ point: "cart.validate", reads }] });
      return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path} ${issue.message}`);
    };
    expect(issues([
      { as: "member", object: "members", key: "customer" },
      { as: "company", object: "companies", key: { from: "member.company_id" } },
      { as: "moq", customFields: ["product:min_qty"], max: 50 },
      { as: "picked", object: "companies", key: "attribute.company" },
    ])).toEqual([]);
    // At most four reads, each name once.
    expect(issues(Array.from({ length: 5 }, (_, index) => ({ as: `r${index}`, object: "ledger", key: "customer" }))).length).toBeGreaterThan(0);
    expect(issues([{ as: "a", object: "ledger", key: "customer" }, { as: "a", object: "ledger", key: "line.productId" }])).toEqual(["functions.0.reads.1.as Read a is declared twice."]);
    // Declared objects, fields and attributes only.
    expect(issues([{ as: "a", object: "nope", key: "customer" }])).toEqual(["functions.0.reads.0.object Object type nope is not declared."]);
    expect(issues([{ as: "a", customFields: ["product:nope"] }])).toEqual(["functions.0.reads.0.customFields Custom field product:nope is not declared in customFields."]);
    expect(issues([{ as: "a", customFields: ["product:min_qty", "customer:points"] }])).toEqual(["functions.0.reads.0.customFields One custom-field read names fields of one owner type."]);
    expect(issues([{ as: "a", customFields: ["product:min_qty"], key: "customer" }])).toEqual(["functions.0.reads.0.key product fields are read by line.productId."]);
    expect(issues([{ as: "a", object: "ledger", key: "attribute.nope" }])).toEqual(["functions.0.reads.0.key Checkout attribute nope is not declared in checkout.attributes."]);
    // max only on a per-line read.
    expect(issues([{ as: "a", object: "ledger", key: "customer", max: 5 }])).toEqual(["functions.0.reads.0.max Only a per-line read (line.variantId, line.productId) takes max."]);
    // One hop, from an earlier single-key read, along a field that holds the hop object's id.
    expect(issues([{ as: "company", object: "companies", key: { from: "member.company_id" } }])).toHaveLength(1);
    expect(issues([{ as: "m", object: "members", key: "line.variantId" }, { as: "c", object: "companies", key: { from: "m.company_id" } }])).toHaveLength(1);
    expect(issues([{ as: "m", object: "members", key: "customer" }, { as: "c", object: "ledger", key: { from: "m.company_id" } }])).toEqual([
      "functions.0.reads.1.key.from m.company_id references acme.loyalty.companies, not acme.loyalty.ledger.",
    ]);
    expect(issues([{ as: "m", object: "members", key: "customer" }, { as: "c", object: "companies", key: { from: "m.note" } }])).toHaveLength(1);
    expect(issues([
      { as: "m", object: "members", key: "customer" },
      { as: "c", object: "companies", key: { from: "m.company_id" } },
      { as: "d", object: "companies", key: { from: "c.name" } },
    ])).toHaveLength(1);
  });

  it("declares buyer UI as storefront extensions, one per UI slot, never as a function point", () => {
    const parse = (input: Partial<PluginManifestInput>) => {
      const parsed = parsePluginManifest({ ...FULL, ...input });
      return parsed.ok ? { ok: true as const, manifest: parsed.manifest } : { ok: false as const, issues: parsed.issues.map((issue) => `${issue.path} ${issue.message}`) };
    };
    const balance = { as: "balance", object: "ledger", key: "customer" as const };
    const ok = parse({ storefront: { extensions: [{ target: "checkout.actions.before", reads: [balance] }, { target: "account.overview", reads: [balance] }] } });
    expect(ok.ok && ok.manifest.storefront.extensions.map((extension) => extension.target)).toEqual(["checkout.actions.before", "account.overview"]);
    expect(ok.ok && pluginGrantRequest(ok.manifest).extensions).toEqual(["account.overview", "checkout.actions.before"]);
    expect(parse({ functions: [{ point: "buyer.ui" } as never] }).ok).toBe(false);
    expect(parse({ storefront: { extensions: [{ target: "account.overview" }, { target: "account.overview" }] } })).toMatchObject({ ok: false, issues: ["storefront.extensions Extension targets must be unique."] });
    expect(parse({ storefront: { extensions: [{ target: "header.actions" as never }] } }).ok).toBe(false);
    // One name, one read across the app's extensions; reads are checked like a function's.
    expect(parse({ storefront: { extensions: [{ target: "account.overview", reads: [balance] }, { target: "account.order", reads: [{ ...balance, key: "line.productId" }] }] } }))
      .toMatchObject({ ok: false, issues: ["storefront.extensions.1.reads.0.as Read balance is declared differently by another extension: one name, one read."] });
    expect(parse({ storefront: { extensions: [{ target: "account.overview", reads: [{ as: "a", object: "nope", key: "customer" }] }] } }))
      .toMatchObject({ ok: false, issues: ["storefront.extensions.0.reads.0.object Object type nope is not declared."] });
  });

  it("commits only named single-key reads, at most four", () => {
    const output = PLUGIN_FUNCTION_SCHEMAS["checkout.discounts"].output;
    expect(output.safeParse({ discounts: [], commit: [{ as: "balance", record: { points: 1 } }] }).success).toBe(true);
    expect(output.safeParse({ discounts: [], commit: { record: { points: 1 } } }).success).toBe(false);
    expect(output.safeParse({ discounts: [], commit: Array.from({ length: 5 }, (_, index) => ({ as: `r${index}`, record: {} })) }).success).toBe(false);
  });

  it("keeps discounts in minor units and rejects a negative or fractional amount", () => {
    const output = PLUGIN_FUNCTION_SCHEMAS["checkout.discounts"].output;
    const discount = (amountMinor: number) => ({ discounts: [{ title: "Points", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor } }] });
    expect(output.safeParse(discount(5000)).success).toBe(true);
    expect(output.safeParse(discount(-1)).success).toBe(false);
    expect(output.safeParse(discount(12.5)).success).toBe(false);
  });
});

describe("the manifest vocabulary", () => {
  const issues = (input: unknown) => {
    const parsed = parsePluginManifest(input);
    return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.path} ${issue.message}`);
  };

  it("takes snake_case for every name, kebab-case only where the name is a URL path segment, and names the rule", () => {
    expect(issues({
      ...FULL,
      routes: { admin: [{ name: "adjust_points" }, { name: "dashboard" }, { name: "adjust" }], public: [{ name: "balance-check" }], webhooks: [] },
      admin: { ...FULL.admin, timeline: [{ kind: "vendor_split", title: "Vendor split" }] },
    })).toEqual([]);
    expect(issues({ ...FULL, admin: { ...FULL.admin, timeline: [{ kind: "vendor-split", title: "Vendor split" }] } }))
      .toEqual(["admin.timeline.0.kind Use snake_case: a lowercase letter, then at most 47 lowercase letters, digits or underscores."]);
    expect(issues({ ...FULL, cron: [{ name: "expire-points", schedule: "0 3 * * *" }] })[0]).toMatch(/^cron\.0\.name Use snake_case/);
    expect(issues({ ...FULL, routes: { ...FULL.routes, public: [{ name: "Balance" }] } })[0])
      .toMatch(/^routes\.public\.0\.name Use snake_case or kebab-case \(this name is part of a URL\)/);
  });

  it("gives every route one shape: webhooks POST and pages GET unless methods say otherwise", () => {
    const parsed = parsePluginManifest({ ...FULL, routes: { ...FULL.routes, admin: [{ name: "dashboard" }, { name: "adjust", methods: ["POST"] }], webhooks: [{ name: "acme-callback" }, { name: "verify", methods: ["GET", "POST"] }] } });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.manifest.routes.admin[0]).toEqual({ name: "dashboard", methods: ["GET"] });
    expect(parsed.manifest.routes.webhooks).toEqual([{ name: "acme-callback", methods: ["POST"] }, { name: "verify", methods: ["GET", "POST"] }]);
    expect(issues({ ...FULL, routes: { ...FULL.routes, webhooks: ["acme-callback"] } })).toHaveLength(1);
    expect(issues({ ...FULL, routes: { ...FULL.routes, webhooks: [{ name: "a" }, { name: "a" }] } })).toEqual(["routes.webhooks Webhook route names must be unique."]);
  });

  it("names a component's targets by slot", () => {
    const component = { type: "stars", name: "Stars" };
    expect(issues({ ...FULL, storefront: { components: [{ ...component, targets: ["product.buy_box.after"] }] } })).toEqual([]);
    expect(issues({ ...FULL, storefront: { components: [{ ...component, targets: ["buy-box" as never] }] } })).toHaveLength(1);
  });

  it("takes an index as one field or a list of one to four, and reads a one-field list as the field", () => {
    const ledger = FULL.objects!.ledger!;
    const parsed = parsePluginManifest({ ...FULL, objects: { ledger: { ...ledger, indexes: [["customer_id"], ["customer_id", "created_at"]] } } });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.manifest.objects.ledger!.indexes).toEqual(["customer_id", ["customer_id", "created_at"]]);
    expect(issues({ ...FULL, objects: { ledger: { ...ledger, indexes: [[]] } } })).toHaveLength(1);
  });

  it("checks a custom field's type with the manifest, not at install", () => {
    expect(issues({ ...FULL, customFields: [{ ownerType: "customer", key: "points", name: "Points", type: "integer" }] })).toEqual([]);
    expect(issues({ ...FULL, customFields: [{ ownerType: "customer", key: "points", name: "Points", type: "number" }] })[0]).toMatch(/^customFields\.0\.type /);
    expect(issues({ ...FULL, customFields: [{ ownerType: "customer", key: "points__total", name: "Points", type: "integer" }] })[0]).toMatch(/^customFields\.0\.key Use snake_case/);
  });

  it("declares message recipients as indexed text fields of its own records, and asks consent for them", () => {
    const subscribers = {
      name: "Subscribers",
      fields: [{ key: "email", name: "Email", type: "single_line_text" }, { key: "joined_at", name: "Joined", type: "integer" }, { key: "phone", name: "Phone", type: "single_line_text" }],
      unique: ["email"],
      indexes: [["phone", "joined_at"]],
    };
    const manifest = { ...FULL, objects: { ...FULL.objects, subscribers }, messaging: { recipients: [{ object: "subscribers", field: "email" }, { object: "subscribers", field: "phone" }] } };
    const parsed = parsePluginManifest(manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(pluginGrantRequest(parsed.manifest).messageRecipients).toEqual(["subscribers.email", "subscribers.phone"]);
    const base = parsePluginManifest(FULL);
    if (!base.ok) throw new Error("fixture");
    expect(pluginGrantExpands(pluginGrantRequest(base.manifest), pluginGrantRequest(parsed.manifest))).toBe(true);
    expect(pluginGrantKey(pluginGrantRequest(base.manifest))).not.toContain("messageRecipients");
    expect(issues({ ...manifest, messaging: { recipients: [{ object: "subscribers", field: "joined_at" }] } }))
      .toEqual(["messaging.recipients.0.field subscribers.joined_at must be a single_line_text field holding an email address or phone number."]);
    expect(issues({ ...manifest, objects: { ...FULL.objects, subscribers: { ...subscribers, unique: [] } } }))
      .toEqual(["messaging.recipients.0.field Index email first in subscribers (or declare it unique) so a message finds its record by index."]);
    expect(issues({ ...manifest, messaging: { recipients: [{ object: "lists", field: "email" }] } })).toEqual(["messaging.recipients.0.object Object type lists is not declared."]);
  });
});
