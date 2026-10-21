// App features (packages/plugin-sdk/docs/apps.md, "Features"): the parts of an app a
// merchant turns on one at a time. A pack with many services (the Bangladesh
// pack: payment gateways, couriers, SMS gateways, fraud checkers, places) asks
// for nothing until the merchant turns a part on, and then only for what that
// part needs (incremental consent, least privilege).
//
// A feature claims items the manifest declares elsewhere by name: providers,
// settings groups (and so their fields; a provider's own fields go with the
// provider), routes, cron jobs, event subscriptions, function points, admin
// surfaces and storefront surfaces. It adds its own scopes and outbound hosts.
// What no feature claims is the app's base: it runs whenever the app runs.
//
// Rules:
//   - every feature starts off; `recommended` only pre-ticks it in a setup
//     screen, a person still turns it on;
//   - turning one on asks consent for that feature's request alone; turning
//     one off revokes it (no approval needed);
//   - an off feature's items are not registered and cost nothing at runtime:
//     the host reads the manifest through `pluginManifestWithFeatures`, so its
//     providers, routes, cron jobs, events, functions, surfaces, settings,
//     scopes and hosts do not exist for the running app;
//   - an item belongs to at most one feature, and may only point at items of
//     its own feature or of the base (validated with the manifest).
//
// Part of the versioned plugin API: within `PLUGIN_API_VERSION` it changes
// only additively.

import { z } from "zod";
import { isEventTopicFilter, type EventTopicFilter } from "../events";
import { PLUGIN_HOST_PATTERN, pluginKeySchema, pluginUrlNameSchema } from "./manifest-patterns";
import { PLUGIN_SCOPE_NAMES, type PluginScope } from "./scopes";
import { STOREFRONT_UI_SLOTS } from "./storefront-protocol";
import type { PluginManifest } from "./manifest";

/** The most features one app declares. */
export const PLUGIN_FEATURES_MAX = 24;

/** Claims by name: snake_case keys, or names that are also URL path segments (snake_case or kebab-case). */
const listOf = (item: z.ZodString, max: number) => z.array(item).max(max).default([])
  .refine((values) => new Set(values).size === values.length, "List each name once.");
const keys = (max: number) => listOf(pluginKeySchema(), max);
const urlNames = (max: number) => listOf(pluginUrlNameSchema(), max);

export const pluginFeatureSchema = z.object({
  /** A URL path segment (`/api/v1/admin/apps/<plugin id>/features/<id>/enable`): snake_case or kebab-case. */
  id: pluginUrlNameSchema(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  /**
   * Suggested during setup (a setup screen ticks it in advance). It still
   * starts off: only a person turns a feature on.
   */
  recommended: z.boolean().default(false),
  /** Store access this feature asks for beyond the app's base `scopes`. */
  scopes: z.array(z.enum(PLUGIN_SCOPE_NAMES)).max(PLUGIN_SCOPE_NAMES.length).default([])
    .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique."),
  /** Outbound hosts only this feature reaches (beyond the app's base `allowedHosts`). */
  allowedHosts: z.array(z.string().toLowerCase().regex(PLUGIN_HOST_PATTERN)).max(20).default([])
    .refine((hosts) => new Set(hosts).size === hosts.length, "List each host once."),
  /** Provider ids (`providers[].id`) this feature contributes, with their own settings fields. */
  providers: urlNames(24),
  /** Settings groups (`settingsGroups[].id`) whose fields belong to this feature. */
  settingsGroups: keys(20),
  routes: z.object({ admin: urlNames(40), public: urlNames(20), webhooks: urlNames(10) }).strict()
    .default({ admin: [], public: [], webhooks: [] }),
  cron: keys(10),
  /** Event topic filters of the manifest's `events` that only this feature subscribes to. */
  events: z.array(z.string().refine(isEventTopicFilter, "Unknown event topic.")).max(40).default([])
    .transform((topics) => topics as EventTopicFilter[]),
  /** Function points of the manifest's `functions` this feature implements. */
  functions: z.array(z.string().min(1).max(64)).max(16).default([]),
  /** Dashboard pages, cards, actions and widgets (by id; a page id may be kebab-case). */
  admin: urlNames(40),
  /** Storefront surfaces by their declared names; extensions by their UI slot. */
  storefront: z.object({
    sections: keys(32),
    components: keys(16),
    skins: keys(30),
    extensions: z.array(z.enum(STOREFRONT_UI_SLOTS)).max(STOREFRONT_UI_SLOTS.length).default([]),
  }).strict().default({ sections: [], components: [], skins: [], extensions: [] }),
}).strict();

export type PluginFeature = z.output<typeof pluginFeatureSchema>;
export type PluginFeatureInput = z.input<typeof pluginFeatureSchema>;

/** Translatable feature text (`translations[<BCP 47>].features[<id>]`). */
export const pluginFeatureTranslationSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();

// ── Ownership ─────────────────────────────────────────────────────────────

type FeatureManifest = Pick<PluginManifest,
  "features" | "providers" | "settings" | "routes" | "cron" | "events" | "functions" | "admin" | "storefront">;

/** Which feature owns each claimed item, by item kind (absent: the base). */
export interface PluginFeatureOwners {
  providers: Map<string, string>;
  settingsGroups: Map<string, string>;
  settings: Map<string, string>;
  adminRoutes: Map<string, string>;
  publicRoutes: Map<string, string>;
  webhooks: Map<string, string>;
  cron: Map<string, string>;
  events: Map<string, string>;
  functions: Map<string, string>;
  admin: Map<string, string>;
  sections: Map<string, string>;
  components: Map<string, string>;
  skins: Map<string, string>;
  extensions: Map<string, string>;
}

/** The owner maps (first claim wins; the manifest refuses a second one). */
export function pluginFeatureOwners(manifest: FeatureManifest): PluginFeatureOwners {
  const owners: PluginFeatureOwners = {
    providers: new Map(), settingsGroups: new Map(), settings: new Map(), adminRoutes: new Map(), publicRoutes: new Map(),
    webhooks: new Map(), cron: new Map(), events: new Map(), functions: new Map(), admin: new Map(),
    sections: new Map(), components: new Map(), skins: new Map(), extensions: new Map(),
  };
  const claim = (map: Map<string, string>, values: readonly string[], feature: string) => {
    for (const value of values) if (!map.has(value)) map.set(value, feature);
  };
  for (const feature of manifest.features) {
    claim(owners.providers, feature.providers, feature.id);
    claim(owners.settingsGroups, feature.settingsGroups, feature.id);
    claim(owners.adminRoutes, feature.routes.admin, feature.id);
    claim(owners.publicRoutes, feature.routes.public, feature.id);
    claim(owners.webhooks, feature.routes.webhooks, feature.id);
    claim(owners.cron, feature.cron, feature.id);
    claim(owners.events, feature.events, feature.id);
    claim(owners.functions, feature.functions, feature.id);
    claim(owners.admin, feature.admin, feature.id);
    claim(owners.sections, feature.storefront.sections, feature.id);
    claim(owners.components, feature.storefront.components, feature.id);
    claim(owners.skins, feature.storefront.skins, feature.id);
    claim(owners.extensions, feature.storefront.extensions, feature.id);
  }
  // A field belongs to the feature of its group: a provider's or a settings group's.
  for (const field of manifest.settings) {
    if (field.group === undefined) continue;
    const owner = owners.providers.get(field.group) ?? owners.settingsGroups.get(field.group);
    if (owner) owners.settings.set(field.key, owner);
  }
  return owners;
}

// ── The running manifest ──────────────────────────────────────────────────

/**
 * The manifest as it runs with `enabled` features on: the base plus those
 * features, with their scopes and hosts joined to the app's. Every runtime
 * reader (registrations, providers, routes, cron, events, functions,
 * surfaces, settings, grants) reads this, so an off feature does not exist
 * while the app runs. `features` keeps every declaration (the dashboard lists
 * them). Unknown ids are ignored. Returns the manifest itself when the app
 * declares no features.
 */
export function pluginManifestWithFeatures(manifest: PluginManifest, enabled: Iterable<string>): PluginManifest {
  if (manifest.features.length === 0) return manifest;
  const on = new Set<string>();
  for (const id of enabled) if (manifest.features.some((feature) => feature.id === id)) on.add(id);
  const owners = pluginFeatureOwners(manifest);
  const keep = (map: Map<string, string>, key: string) => {
    const owner = map.get(key);
    return owner === undefined || on.has(owner);
  };
  const onFeatures = manifest.features.filter((feature) => on.has(feature.id));
  const union = <T extends string>(base: readonly T[], extra: readonly T[]) => [...new Set([...base, ...extra])];
  return {
    ...manifest,
    scopes: union(manifest.scopes, onFeatures.flatMap((feature) => feature.scopes)),
    allowedHosts: union(manifest.allowedHosts, onFeatures.flatMap((feature) => feature.allowedHosts)),
    providers: manifest.providers.filter((provider) => keep(owners.providers, provider.id)),
    settings: manifest.settings.filter((field) => keep(owners.settings, field.key)),
    routes: {
      admin: manifest.routes.admin.filter((route) => keep(owners.adminRoutes, route.name)),
      public: manifest.routes.public.filter((route) => keep(owners.publicRoutes, route.name)),
      webhooks: manifest.routes.webhooks.filter((route) => keep(owners.webhooks, route.name)),
    },
    cron: manifest.cron.filter((job) => keep(owners.cron, job.name)),
    events: manifest.events.filter((filter) => keep(owners.events, filter)),
    functions: manifest.functions.filter((fn) => keep(owners.functions, fn.point)),
    admin: {
      ...manifest.admin,
      pages: manifest.admin.pages.filter((page) => keep(owners.admin, page.id)),
      cards: manifest.admin.cards.filter((card) => keep(owners.admin, card.id)),
      actions: manifest.admin.actions.filter((action) => keep(owners.admin, action.id)),
      widgets: manifest.admin.widgets.filter((widget) => keep(owners.admin, widget.id)),
      settingsGroups: manifest.admin.settingsGroups.filter((group) => keep(owners.settingsGroups, group.id)),
    },
    storefront: {
      ...manifest.storefront,
      sections: manifest.storefront.sections.filter((section) => keep(owners.sections, section.type)),
      components: manifest.storefront.components.filter((component) => keep(owners.components, component.type)),
      skins: manifest.storefront.skins.filter((skin) => keep(owners.skins, skin.id)),
      extensions: manifest.storefront.extensions.filter((extension) => keep(owners.extensions, extension.target)),
    },
  };
}

/** The feature ids of `requested` the manifest declares, in declaration order. */
export function knownPluginFeatures(manifest: Pick<PluginManifest, "features">, requested: Iterable<string>): string[] {
  const wanted = new Set(requested);
  return manifest.features.filter((feature) => wanted.has(feature.id)).map((feature) => feature.id);
}

/**
 * What turning one feature on asks for, in the consent screen's words: its
 * own scopes and hosts, and what it adds (providers by port, public routes,
 * events, functions). Only the feature's own claims, never the base's.
 */
export interface PluginFeatureRequest {
  scopes: PluginScope[];
  allowedHosts: string[];
  providers: Array<{ id: string; kind: string; name: string }>;
  events: EventTopicFilter[];
  functions: string[];
  publicRoutes: boolean;
  storefront: boolean;
  admin: boolean;
  cron: string[];
}

export function pluginFeatureRequest(manifest: PluginManifest, featureId: string): PluginFeatureRequest | null {
  const feature = manifest.features.find((entry) => entry.id === featureId);
  if (!feature) return null;
  const sorted = <T extends string>(values: Iterable<T>) => [...new Set(values)].sort();
  return {
    scopes: sorted(feature.scopes.filter((scope) => !manifest.scopes.includes(scope))),
    allowedHosts: sorted(feature.allowedHosts.filter((host) => !manifest.allowedHosts.includes(host))),
    providers: manifest.providers
      .filter((provider) => feature.providers.includes(provider.id))
      .map((provider) => ({ id: provider.id, kind: provider.kind, name: provider.name })),
    events: sorted(feature.events),
    functions: sorted(feature.functions),
    publicRoutes: feature.routes.public.length > 0 || feature.routes.webhooks.length > 0,
    storefront: Object.values(feature.storefront).some((list) => list.length > 0),
    admin: feature.admin.length > 0,
    cron: [...feature.cron],
  };
}

// ── Validation (with the manifest) ────────────────────────────────────────

type Issue = { path: (string | number)[]; message: string };

/**
 * Every way the features disagree with the rest of the manifest: a claim of
 * something undeclared, a second claim, a scope or host the base already
 * has, and an item that points at another feature's item (an admin page at a
 * route of an off feature would break when that feature is off).
 */
export function pluginFeatureIssues(manifest: PluginManifest): Issue[] {
  const issues: Issue[] = [];
  if (manifest.features.length === 0) return issues;
  const ids = manifest.features.map((feature) => feature.id);
  if (new Set(ids).size !== ids.length) issues.push({ path: ["features"], message: "Feature ids must be unique." });

  const declared = {
    providers: new Set(manifest.providers.map((provider) => provider.id)),
    settingsGroups: new Set(manifest.admin.settingsGroups.map((group) => group.id)),
    adminRoutes: new Set(manifest.routes.admin.map((route) => route.name)),
    publicRoutes: new Set(manifest.routes.public.map((route) => route.name)),
    webhooks: new Set(manifest.routes.webhooks.map((route) => route.name)),
    cron: new Set(manifest.cron.map((job) => job.name)),
    events: new Set<string>(manifest.events),
    functions: new Set<string>(manifest.functions.map((fn) => fn.point)),
    admin: new Set([...manifest.admin.pages, ...manifest.admin.cards, ...manifest.admin.actions, ...manifest.admin.widgets].map((item) => item.id)),
    sections: new Set(manifest.storefront.sections.map((section) => section.type)),
    components: new Set(manifest.storefront.components.map((component) => component.type)),
    skins: new Set(manifest.storefront.skins.map((skin) => skin.id)),
    extensions: new Set<string>(manifest.storefront.extensions.map((extension) => extension.target)),
  };
  const claimed = new Map<string, string>();
  manifest.features.forEach((feature, index) => {
    const at = (...path: (string | number)[]) => ["features", index, ...path];
    const check = (kind: keyof typeof declared, values: readonly string[], path: (string | number)[], label: string) => {
      values.forEach((value, valueIndex) => {
        if (!declared[kind].has(value)) issues.push({ path: [...path, valueIndex], message: `${label} ${value} is not declared.` });
        const key = `${kind}:${value}`;
        const owner = claimed.get(key);
        if (owner !== undefined && owner !== feature.id) {
          issues.push({ path: [...path, valueIndex], message: `${label} ${value} already belongs to feature ${owner}.` });
        } else claimed.set(key, feature.id);
      });
    };
    check("providers", feature.providers, at("providers"), "Provider");
    check("settingsGroups", feature.settingsGroups, at("settingsGroups"), "Settings group");
    check("adminRoutes", feature.routes.admin, at("routes", "admin"), "Admin route");
    check("publicRoutes", feature.routes.public, at("routes", "public"), "Public route");
    check("webhooks", feature.routes.webhooks, at("routes", "webhooks"), "Webhook route");
    check("cron", feature.cron, at("cron"), "Cron job");
    check("events", feature.events, at("events"), "Event subscription");
    check("functions", feature.functions, at("functions"), "Function point");
    check("admin", feature.admin, at("admin"), "Admin surface");
    check("sections", feature.storefront.sections, at("storefront", "sections"), "Section");
    check("components", feature.storefront.components, at("storefront", "components"), "Component");
    check("skins", feature.storefront.skins, at("storefront", "skins"), "Skin");
    check("extensions", feature.storefront.extensions, at("storefront", "extensions"), "Extension");
    feature.scopes.forEach((scope, scopeIndex) => {
      if (manifest.scopes.includes(scope)) issues.push({ path: at("scopes", scopeIndex), message: `${scope} is already a base scope of the app.` });
    });
    feature.allowedHosts.forEach((host, hostIndex) => {
      if (manifest.allowedHosts.includes(host)) issues.push({ path: at("allowedHosts", hostIndex), message: `${host} is already a base host of the app.` });
    });
  });
  if (issues.length > 0) return issues;

  // References stay inside one feature (or point at the base).
  const owners = pluginFeatureOwners(manifest);
  const scopesOf = (owner: string | undefined) => new Set([
    ...manifest.scopes,
    ...(owner === undefined ? [] : manifest.features.find((feature) => feature.id === owner)?.scopes ?? []),
  ]);
  const reaches = (from: string | undefined, to: string | undefined) => to === undefined || to === from;
  const where = (owner: string | undefined) => (owner === undefined ? "the base" : `feature ${owner}`);
  const refer = (path: (string | number)[], from: string | undefined, to: string | undefined, what: string) => {
    if (!reaches(from, to)) issues.push({ path, message: `${what} belongs to ${where(to)}, but this belongs to ${where(from)}.` });
  };
  manifest.routes.admin.forEach((route, index) => {
    const owner = owners.adminRoutes.get(route.name);
    if (route.scope && !scopesOf(owner).has(route.scope)) {
      issues.push({ path: ["routes", "admin", index, "scope"], message: `Scope ${route.scope} is not a scope of ${where(owner)}.` });
    }
  });
  const surfaces = [
    ...manifest.admin.pages.flatMap((page, index) => [
      { owner: owners.admin.get(page.id), route: page.route, path: ["admin", "pages", index, "route"] as (string | number)[] },
      ...(page.tabs ?? []).map((tab, tabIndex) => ({ owner: owners.admin.get(page.id), route: tab.route, path: ["admin", "pages", index, "tabs", tabIndex, "route"] as (string | number)[] })),
    ]),
    ...manifest.admin.cards.map((card, index) => ({ owner: owners.admin.get(card.id), route: card.route, path: ["admin", "cards", index, "route"] as (string | number)[] })),
    ...manifest.admin.actions.map((action, index) => ({ owner: owners.admin.get(action.id), route: action.route, path: ["admin", "actions", index, "route"] as (string | number)[] })),
    ...manifest.admin.widgets.map((widget, index) => ({ owner: owners.admin.get(widget.id), route: widget.route, path: ["admin", "widgets", index, "route"] as (string | number)[] })),
  ];
  for (const surface of surfaces) refer(surface.path, surface.owner, owners.adminRoutes.get(surface.route), `Admin route ${surface.route}`);
  manifest.providers.forEach((provider, index) => {
    const owner = owners.providers.get(provider.id);
    for (const key of provider.settings ?? []) {
      refer(["providers", index, "settings"], owner, owners.settings.get(key), `Setting ${key}`);
    }
    if (provider.environmentSetting !== undefined) {
      refer(["providers", index, "environmentSetting"], owner, owners.settings.get(provider.environmentSetting), `Setting ${provider.environmentSetting}`);
    }
  });
  return issues;
}
