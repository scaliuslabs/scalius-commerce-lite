// Plugin manifest (docs/platform/PLUGINS.md). One strict document says
// everything a plugin may do; the platform derives the consent screen, the
// runtime grants and the dashboard/storefront surfaces from it, so nothing a
// plugin does is undeclared. Validated at every parse site (pack, install,
// load). Part of the versioned plugin API: within `PLUGIN_API_VERSION` it
// changes only additively.

import { z } from "zod";
import { isEventTopicFilter, topicMatchesAnyFilter, type EventTopic, type EventTopicFilter } from "../events";
import { SUPPORTED_PLUGIN_API_VERSIONS } from "./api-version";
import { parsePluginCronSchedule } from "./cron";
import { FIRST_PARTY_PLUGIN_VENDOR, PLUGIN_ID_PATTERN } from "./ids";
import { pluginSettingsSchemaSchema } from "./settings-schema";

/** Date-versioned like the event catalog; a manifest names the version it was built for. */
export { PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS, type PluginApiVersion } from "./api-version";

/** `vendor.name` (in ./ids.ts, so id checks don't need this schema module). */
export { FIRST_PARTY_PLUGIN_VENDOR, PLUGIN_ID_PATTERN };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,40})?$/;
/**
 * RBAC permission names, as staff roles use them (`orders.view`,
 * `settings.shipping_methods.view`); checked against the live catalog at
 * install.
 */
export const PLUGIN_PERMISSION_PATTERN = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*){1,2}$/;
/** Route, page, card, action, cron, collection and section names. */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
/** Exact hosts or one leading wildcard label (`*.example.com`); never IP literals or localhost. */
export const PLUGIN_HOST_PATTERN = /^(?:\*\.)?(?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const name = z.string().regex(PLUGIN_NAME_PATTERN);
const title = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);

// ── Extension points ──────────────────────────────────────────────────────

/** Synchronous decision points: pure input → output, strict limits (functions.ts). */
export const PLUGIN_FUNCTION_POINTS = [
  "cart.validate",
  "checkout.discounts",
  "checkout.shipping_rates",
  "checkout.payment_methods",
  "order.risk",
] as const;
export type PluginFunctionPoint = (typeof PLUGIN_FUNCTION_POINTS)[number];

/** Provider ports a plugin can fill; each maps to an existing core provider interface. */
export const PLUGIN_PROVIDER_KINDS = ["payment", "shipping", "messaging", "email", "fraud", "tax"] as const;
export type PluginProviderKind = (typeof PLUGIN_PROVIDER_KINDS)[number];

/** Resources a dashboard card or action can attach to. */
export const PLUGIN_ADMIN_TARGETS = ["product", "variant", "order", "customer", "category", "collection", "brand", "page", "return"] as const;
export type PluginAdminTarget = (typeof PLUGIN_ADMIN_TARGETS)[number];

/** Where a plugin page appears in the dashboard navigation. */
export const PLUGIN_NAV_PLACEMENTS = ["apps", "orders", "products", "customers", "marketing", "content", "analytics", "settings"] as const;

export const PLUGIN_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const routeSchema = z.object({
  name,
  methods: z.array(z.enum(PLUGIN_HTTP_METHODS)).min(1).max(5),
  description: description.optional(),
}).strict();

/**
 * Five-field cron in the store's time zone (cron.ts). The platform checks
 * schedules on its scheduled tick, so a finer schedule runs once per tick.
 */
const cronSchedule = z.string().trim().regex(/^(\S+\s+){4}\S+$/, "Use a five-field cron schedule.")
  .superRefine((value, context) => {
    const parsed = parsePluginCronSchedule(value);
    if (typeof parsed === "string") context.addIssue({ code: "custom", message: parsed });
  });

/** A top-level JSON key of a stored record. */
const recordField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,47}$/);
const storageCollectionSchema = z.object({
  /** Up to four indexed fields (each a top-level JSON key); compound indexes use an array. */
  indexes: z.array(z.union([recordField, z.array(recordField).min(2).max(4)])).max(4).default([]),
  unique: z.array(z.union([recordField, z.array(recordField).min(2).max(4)])).max(2).default([]),
}).strict();

const customFieldSchema = z.object({
  ownerType: z.enum(["product", "variant", "customer", "order", "category", "collection", "brand", "page"]),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: title,
  /** A custom-field type id from `@scalius/shared/custom-fields`; checked at install. */
  type: z.string().min(1).max(48),
  description: description.optional(),
  storefrontVisible: z.boolean().default(false),
}).strict();

const adminSchema = z.object({
  /** Full pages; their content is the declarative UI tree the plugin's admin route returns. */
  pages: z.array(z.object({
    id: name,
    title,
    placement: z.enum(PLUGIN_NAV_PLACEMENTS).default("apps"),
    /** The admin route that returns the page's UI tree. */
    route: name,
  }).strict()).max(10).default([]),
  /** Cards on a resource's detail page. */
  cards: z.array(z.object({ id: name, target: z.enum(PLUGIN_ADMIN_TARGETS), title, route: name }).strict()).max(20).default([]),
  /** Buttons on a resource's detail page or bulk bar; they POST to an admin route. */
  actions: z.array(z.object({
    id: name,
    target: z.enum(PLUGIN_ADMIN_TARGETS),
    label: title,
    route: name,
    bulk: z.boolean().default(false),
    destructive: z.boolean().default(false),
  }).strict()).max(20).default([]),
  /** Dashboard home widgets. */
  widgets: z.array(z.object({ id: name, title, route: name }).strict()).max(5).default([]),
}).strict();

const storefrontSchema = z.object({
  /** Theme sections the merchant can add in the theme editor/builder. */
  sections: z.array(z.object({
    type: name,
    name: title,
    description: description.optional(),
    settings: pluginSettingsSchemaSchema.default([]),
    /** The public route that renders the section (sanitized HTML), cached under dependency validation. */
    route: name,
    /**
     * Storage collections the render reads. Rendering may read only these
     * (and the app's settings); a write to one invalidates the cached
     * section. Nothing declared: the output depends on settings alone.
     */
    reads: z.array(name).max(20).default([]),
  }).strict()).max(20).default([]),
  /** Blocks inside the product page's purchase area or below it. */
  productBlocks: z.array(z.object({
    type: name,
    name: title,
    placement: z.enum(["buy-box", "below"]),
    settings: pluginSettingsSchemaSchema.default([]),
    route: name,
    /** As for sections. */
    reads: z.array(name).max(20).default([]),
  }).strict()).max(10).default([]),
  /** Meta tags and JSON-LD (sanitized) for the page head. */
  head: z.boolean().default(false),
  /** External scripts; their hosts join the storefront CSP. Loaded non-blocking. */
  scripts: z.array(z.object({
    src: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Scripts load over https."),
    placement: z.enum(["head", "body-end"]).default("body-end"),
    pages: z.array(z.enum(["all", "home", "product", "listing", "cart", "checkout", "order-success"])).min(1).default(["all"]),
  }).strict()).max(5).default([]),
  /** `/apps/<plugin id>/*` on the storefront origin proxies to the plugin's public routes. */
  proxy: z.boolean().default(false),
}).strict();

// ── Manifest ──────────────────────────────────────────────────────────────

export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN, "Use vendor.name in lowercase."),
  name: title,
  version: z.string().regex(SEMVER, "Use a semantic version."),
  apiVersion: z.enum(SUPPORTED_PLUGIN_API_VERSIONS),
  description,
  author: z.object({ name: title, url: z.string().url().optional(), email: z.string().email().optional() }).strict(),
  homepage: z.string().url().optional(),
  license: z.string().max(64).optional(),

  /** Store data and actions, as RBAC permission names; every `ctx.api` call is checked against them. */
  permissions: z.array(z.string().regex(PLUGIN_PERMISSION_PATTERN)).max(80).default([]),
  /** Outbound hosts for `ctx.http.fetch` (none means no network). */
  allowedHosts: z.array(z.string().toLowerCase().regex(PLUGIN_HOST_PATTERN)).max(20).default([]),

  events: z.array(z.string().refine(isEventTopicFilter, "Unknown event topic.")).max(40).default([])
    .transform((topics) => topics as EventTopicFilter[]),
  functions: z.array(z.object({
    point: z.enum(PLUGIN_FUNCTION_POINTS),
    /** Lower runs first among plugins at the same point. */
    priority: z.number().int().min(0).max(1000).default(100),
  }).strict()).max(PLUGIN_FUNCTION_POINTS.length).default([]),
  providers: z.array(z.object({
    kind: z.enum(PLUGIN_PROVIDER_KINDS),
    /** Unique within the plugin; the merchant picks providers by `<plugin id>/<id>`. */
    id: name,
    name: title,
  }).strict()).max(10).default([]),

  routes: z.object({
    /** Dashboard-authenticated (`/api/v1/plugins/<id>/admin/<name>`). */
    admin: z.array(routeSchema).max(40).default([]),
    /** Unauthenticated, rate-limited (`/api/v1/plugins/<id>/public/<name>`). */
    public: z.array(routeSchema).max(20).default([]),
    /** Inbound provider webhooks (`/api/v1/plugins/<id>/webhooks/<name>`), raw body preserved. */
    webhooks: z.array(name).max(10).default([]),
  }).strict().default({ admin: [], public: [], webhooks: [] }),
  cron: z.array(z.object({ name, schedule: cronSchedule }).strict()).max(10).default([]),

  storage: z.record(name, storageCollectionSchema).default({})
    .refine((collections) => Object.keys(collections).length <= 20, "At most 20 storage collections."),
  customFields: z.array(customFieldSchema).max(50).default([]),
  settings: pluginSettingsSchemaSchema.default([]),

  admin: adminSchema.default({ pages: [], cards: [], actions: [], widgets: [] }),
  storefront: storefrontSchema.default({ sections: [], productBlocks: [], head: false, scripts: [], proxy: false }),

  /** Per-invocation limits, within the platform's ceilings. */
  limits: z.object({
    cpuMs: z.number().int().min(5).max(200).default(50),
    wallMs: z.number().int().min(100).max(30_000).default(10_000),
  }).strict().default({ cpuMs: 50, wallMs: 10_000 }),
}).strict().superRefine((manifest, context) => {
  const routes = new Set([...manifest.routes.admin, ...manifest.routes.public].map((route) => route.name));
  const adminRoutes = new Set(manifest.routes.admin.map((route) => route.name));
  const publicRoutes = new Set(manifest.routes.public.map((route) => route.name));
  if (routes.size !== manifest.routes.admin.length + manifest.routes.public.length) {
    context.addIssue({ code: "custom", path: ["routes"], message: "Route names must be unique across admin and public routes." });
  }
  const needAdminRoute = (path: (string | number)[], route: string) => {
    if (!adminRoutes.has(route)) context.addIssue({ code: "custom", path, message: `Admin route ${route} is not declared.` });
  };
  manifest.admin.pages.forEach((page, index) => needAdminRoute(["admin", "pages", index, "route"], page.route));
  manifest.admin.cards.forEach((card, index) => needAdminRoute(["admin", "cards", index, "route"], card.route));
  manifest.admin.actions.forEach((action, index) => needAdminRoute(["admin", "actions", index, "route"], action.route));
  manifest.admin.widgets.forEach((widget, index) => needAdminRoute(["admin", "widgets", index, "route"], widget.route));
  const needPublicRoute = (path: (string | number)[], route: string) => {
    if (!publicRoutes.has(route)) context.addIssue({ code: "custom", path, message: `Public route ${route} is not declared.` });
  };
  const collections = new Set(Object.keys(manifest.storage));
  const surfaces = [
    ...manifest.storefront.sections.map((surface, index) => ({ surface, path: ["storefront", "sections", index] as (string | number)[] })),
    ...manifest.storefront.productBlocks.map((surface, index) => ({ surface, path: ["storefront", "productBlocks", index] as (string | number)[] })),
  ];
  for (const { surface, path } of surfaces) {
    needPublicRoute([...path, "route"], surface.route);
    surface.reads.forEach((collection, readIndex) => {
      if (!collections.has(collection)) {
        context.addIssue({ code: "custom", path: [...path, "reads", readIndex], message: `Storage collection ${collection} is not declared.` });
      }
    });
    surface.settings.forEach((field, fieldIndex) => {
      if (field.type === "secret") {
        context.addIssue({ code: "custom", path: [...path, "settings", fieldIndex, "type"], message: "Storefront settings are public: keep secrets in the app's settings." });
      }
    });
  }
  if (manifest.storefront.proxy && publicRoutes.size === 0) {
    context.addIssue({ code: "custom", path: ["storefront", "proxy"], message: "The storefront proxy needs at least one public route." });
  }
  const unique = (values: string[], path: (string | number)[], what: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path, message: `${what} must be unique.` });
  };
  unique(manifest.functions.map((fn) => fn.point), ["functions"], "Function points");
  unique(manifest.providers.map((provider) => provider.id), ["providers"], "Provider ids");
  unique(manifest.cron.map((job) => job.name), ["cron"], "Cron names");
  unique(manifest.customFields.map((field) => `${field.ownerType}:${field.key}`), ["customFields"], "Custom field keys");
  unique(manifest.storefront.sections.map((section) => section.type), ["storefront", "sections"], "Section types");
  unique(manifest.storefront.productBlocks.map((block) => block.type), ["storefront", "productBlocks"], "Product block types");
  unique([...manifest.admin.pages, ...manifest.admin.cards, ...manifest.admin.actions, ...manifest.admin.widgets].map((item) => item.id), ["admin"], "Admin ids");
});

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;
export type PluginManifest = z.output<typeof pluginManifestSchema>;

export function parsePluginManifest(value: unknown):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  const result = pluginManifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })),
  };
}

// ── Consent ───────────────────────────────────────────────────────────────

/**
 * Everything a manifest asks for, grouped for the consent screen. A grant
 * records exactly this; an update whose `grantKey` differs needs approval
 * again.
 */
export interface PluginGrantRequest {
  permissions: string[];
  allowedHosts: string[];
  events: EventTopicFilter[];
  functions: PluginFunctionPoint[];
  providers: PluginProviderKind[];
  publicRoutes: boolean;
  storefrontScripts: string[];
  storefrontSurfaces: boolean;
  customFieldOwners: string[];
}

export function pluginGrantRequest(manifest: PluginManifest): PluginGrantRequest {
  const sorted = <T extends string>(values: Iterable<T>) => [...new Set(values)].sort();
  return {
    permissions: sorted(manifest.permissions),
    allowedHosts: sorted(manifest.allowedHosts),
    events: sorted(manifest.events),
    functions: sorted(manifest.functions.map((fn) => fn.point)),
    providers: sorted(manifest.providers.map((provider) => provider.kind)),
    publicRoutes: manifest.routes.public.length > 0 || manifest.routes.webhooks.length > 0 || manifest.storefront.proxy,
    storefrontScripts: sorted(manifest.storefront.scripts.map((script) => new URL(script.src).host)),
    storefrontSurfaces: manifest.storefront.sections.length > 0 || manifest.storefront.productBlocks.length > 0 || manifest.storefront.head,
    customFieldOwners: sorted(manifest.customFields.map((field) => field.ownerType)),
  };
}

/** A stable key of a grant request: equal keys need no new approval. */
export function pluginGrantKey(request: PluginGrantRequest): string {
  return JSON.stringify(request);
}

/** Whether `next` asks for anything `granted` did not (a narrower update needs no approval). */
export function pluginGrantExpands(granted: PluginGrantRequest, next: PluginGrantRequest): boolean {
  const grows = (before: readonly string[], after: readonly string[]) => after.some((value) => !before.includes(value));
  return grows(granted.permissions, next.permissions)
    || grows(granted.allowedHosts, next.allowedHosts)
    || next.events.some((filter) => !eventFilterCovered(filter, granted.events))
    || grows(granted.functions, next.functions)
    || grows(granted.providers, next.providers)
    || (!granted.publicRoutes && next.publicRoutes)
    || grows(granted.storefrontScripts, next.storefrontScripts)
    || (!granted.storefrontSurfaces && next.storefrontSurfaces)
    || grows(granted.customFieldOwners, next.customFieldOwners);
}

/**
 * What `next` asks for beyond `granted`, item by item (everything when
 * nothing was granted): the consent screen marks these as new. Empty lists
 * and false flags everywhere exactly when `pluginGrantExpands` is false.
 */
export function pluginGrantAdditions(granted: PluginGrantRequest | null, next: PluginGrantRequest): PluginGrantRequest {
  if (!granted) return next;
  const added = <T extends string>(before: readonly T[], after: readonly T[]) => after.filter((value) => !before.includes(value));
  return {
    permissions: added(granted.permissions, next.permissions),
    allowedHosts: added(granted.allowedHosts, next.allowedHosts),
    events: next.events.filter((filter) => !eventFilterCovered(filter, granted.events)),
    functions: added(granted.functions, next.functions),
    providers: added(granted.providers, next.providers),
    publicRoutes: next.publicRoutes && !granted.publicRoutes,
    storefrontScripts: added(granted.storefrontScripts, next.storefrontScripts),
    storefrontSurfaces: next.storefrontSurfaces && !granted.storefrontSurfaces,
    customFieldOwners: added(granted.customFieldOwners, next.customFieldOwners),
  };
}

/** Whether a topic filter asks for nothing beyond the granted filters. */
function eventFilterCovered(filter: EventTopicFilter, granted: readonly EventTopicFilter[]): boolean {
  if (granted.includes("*") || granted.includes(filter)) return true;
  if (filter === "*" || filter.endsWith(".*")) return false;
  return topicMatchesAnyFilter(filter as EventTopic, granted);
}
