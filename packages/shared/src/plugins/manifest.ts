// Plugin manifest (docs/platform/PLUGINS.md). One strict document says
// everything a plugin may do; the platform derives the consent screen, the
// runtime grants and the dashboard/storefront surfaces from it, so nothing a
// plugin does is undeclared. Validated at every parse site (pack, install,
// load). Part of the versioned plugin API: within `PLUGIN_API_VERSION` it
// changes only additively.

import { z } from "zod";
import { isEventTopicFilter, topicMatchesAnyFilter, type EventTopic, type EventTopicFilter } from "../events";
import { SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "./api-version";
import { parsePluginCronSchedule } from "./cron";
import { FIRST_PARTY_PLUGIN_VENDOR, PLUGIN_ID_PATTERN } from "./ids";
import { pluginSettingsSchemaSchema } from "./settings-schema";
import { pluginProvidersSchema } from "./providers/descriptors";
import { PROVIDER_KINDS } from "./providers/kinds";

/** Date-versioned like the event catalog; a manifest names the version it was built for. */
export { PLUGIN_API_VERSION, SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS, type PluginApiVersion } from "./api-version";

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
/**
 * Exact hosts or one leading wildcard label (`*.example.com`); never IP
 * literals or localhost. An exact host may name one non-default https port
 * (`sandbox.example.com:10061`, a provider sandbox's): only that port is
 * then reachable on it.
 */
export const PLUGIN_HOST_PATTERN = /^(?:(?:\*\.)?(?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?=[a-z0-9.-]{1,253}:)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))$/;

/**
 * Whether `allowedHosts` lets a request reach `hostname` on `port` ("" for
 * the default https port). A wildcard matches subdomains only, and only on
 * the default port; a non-default port needs its exact `host:port` entry.
 */
export function isPluginHostAllowed(hostname: string, allowedHosts: readonly string[], port = ""): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (port !== "" && port !== "443") return allowedHosts.some((pattern) => pattern.toLowerCase() === `${host}:${port}`);
  return allowedHosts.some((pattern) => {
    const allowed = pattern.toLowerCase();
    if (allowed.includes(":")) return false;
    if (allowed.startsWith("*.")) return host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1;
    return host === allowed;
  });
}

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

/**
 * Points where an app may stop checkout when it cannot answer
 * (`onError: "block"`): a check the store relies on (address or stock
 * verification, payment eligibility). Elsewhere a failure only leaves the
 * app out.
 */
export const PLUGIN_BLOCKING_FUNCTION_POINTS = ["cart.validate", "checkout.payment_methods"] as const satisfies readonly PluginFunctionPoint[];

/** Provider ports a plugin can fill: the same ports the platform's own adapters implement (providers.ts). */
export const PLUGIN_PROVIDER_KINDS = PROVIDER_KINDS;
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

// ── Listing ───────────────────────────────────────────────────────────────

/**
 * What the Apps page groups and filters by: the Shopify App Store
 * subcategories that fit a store on this platform (shopify.dev, "App listing
 * categories"). An app names one to three, the first is its main one.
 */
export const PLUGIN_CATEGORIES = [
  "payments",
  "shipping",
  "orders",
  "inventory",
  "returns",
  "checkout",
  "pricing",
  "marketing",
  "loyalty",
  "store-design",
  "content",
  "notifications",
  "analytics",
  "finances",
  "support",
  "operations",
  "compliance",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** Image types an app's icon may be; a screenshot is a raster image. */
export const PLUGIN_ICON_TYPES = { svg: "image/svg+xml", png: "image/png" } as const;
export const PLUGIN_SCREENSHOT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const;
export const PLUGIN_ICON_MAX_BYTES = 64 * 1024;
export const PLUGIN_SCREENSHOT_MAX_BYTES = 512 * 1024;
export const PLUGIN_SCREENSHOTS_MAX = 6;

/**
 * A file in the plugin's package (`assets/icon.svg`): relative, lowercase,
 * no `..`. The packer reads, checks and bundles it with the plugin.
 */
const assetPath = (types: Record<string, string>) => z.string().max(128)
  .regex(/^(?!.*\.\.)[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/, "Use a relative lowercase path inside the plugin.")
  .refine((path) => Object.hasOwn(types, path.slice(path.lastIndexOf(".") + 1)), `Use a ${Object.keys(types).join(", ")} file.`);

/** The content type of an asset path the manifest accepted. */
export function pluginAssetContentType(path: string): string | null {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return (PLUGIN_ICON_TYPES as Record<string, string>)[extension] ?? (PLUGIN_SCREENSHOT_TYPES as Record<string, string>)[extension] ?? null;
}

const httpsUrl = z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an https address.");
const tagline = z.string().trim().min(1).max(100);
const platformVersion = z.string().regex(SEMVER, "Use a semantic version.");

/** Whether semantic version `left` is below `right` (pre-release tags ignored). */
function semverBelow(left: string, right: string): boolean {
  const parts = (value: string) => value.split("-")[0]!.split(".").map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]!;
  }
  return false;
}

// ── Translations ──────────────────────────────────────────────────────────

/** Dashboard languages besides English, the manifest's own language. */
export const PLUGIN_TRANSLATION_LOCALES = ["bn"] as const;
export type PluginTranslationLocale = (typeof PLUGIN_TRANSLATION_LOCALES)[number];

/**
 * The manifest's merchant-facing text in another dashboard language: the
 * app's name, tagline and description, and its pages', cards', actions' and
 * widgets' titles by id. Anything left out shows in English. An app's own screens
 * pick their language from `adminContext(request).locale`.
 */
const pluginTranslationSchema = z.object({
  name: title.optional(),
  tagline: tagline.optional(),
  description: description.optional(),
  pages: z.record(name, title).optional(),
  cards: z.record(name, title).optional(),
  actions: z.record(name, title).optional(),
  widgets: z.record(name, title).optional(),
}).strict();
export type PluginTranslation = z.infer<typeof pluginTranslationSchema>;

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

  // Listing: what the Apps page shows before and after install (Shopify App
  // Store and WordPress plugin directory fields). None of it is a capability.
  /** Square SVG or PNG in the plugin package, at most 64 KiB; an SVG may hold no script or outside reference. */
  icon: assetPath(PLUGIN_ICON_TYPES).optional(),
  /** One line under the name; `description` says the rest. */
  tagline: tagline.optional(),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).max(3).default([]),
  /** PNG, JPEG or WebP images in the plugin package, at most 512 KiB each. */
  screenshots: z.array(assetPath(PLUGIN_SCREENSHOT_TYPES)).max(PLUGIN_SCREENSHOTS_MAX).default([]),
  support: z.object({ url: httpsUrl.optional(), email: z.string().email().max(254).optional() }).strict()
    .refine((support) => support.url !== undefined || support.email !== undefined, "Give a support address or email.")
    .optional(),
  privacyPolicyUrl: httpsUrl.optional(),
  documentationUrl: httpsUrl.optional(),
  changelogUrl: httpsUrl.optional(),
  /** ISO 3166-1 alpha-2 codes of the countries the app serves; left out, it serves every country. */
  countries: z.array(z.string().regex(/^[A-Z]{2}$/, "Use ISO 3166-1 alpha-2 codes, upper case.")).min(1).max(250).optional(),
  /** The oldest Scalius release the app runs on. */
  minPlatformVersion: platformVersion.optional(),

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
    /**
     * What a throw, timeout or invalid answer does: `skip` leaves the app out
     * (fail open); `block` stops checkout with the store's buyer-safe message
     * (cart.validate and checkout.payment_methods only).
     */
    onError: z.enum(["skip", "block"]).default("skip"),
    /**
     * checkout.discounts only: the signed-in buyer's record in this
     * collection (record id = customer id) is passed in as `snapshot`, and
     * the answer may `commit` a new version of it, written with the order in
     * the same atomic batch at the revision the function saw (a spent
     * balance can never be spent twice).
     */
    snapshot: z.object({ collection: name }).strict().optional(),
  }).strict()).max(PLUGIN_FUNCTION_POINTS.length).default([]),
  /**
   * Providers the app implements, grouped by port (providers/descriptors.ts).
   * Ids are unique within the app; merchants and orders name a provider
   * `<plugin id>:<id>`.
   */
  providers: pluginProvidersSchema,

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
  /** The dashboard text in other languages (additive; English is the manifest itself). */
  translations: z.object({ bn: pluginTranslationSchema.optional() }).strict().optional(),

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
  for (const locale of PLUGIN_TRANSLATION_LOCALES) {
    const translation = manifest.translations?.[locale];
    if (!translation) continue;
    for (const surface of ["pages", "cards", "actions", "widgets"] as const) {
      const declared = new Set(manifest.admin[surface].map((entry) => entry.id));
      for (const id of Object.keys(translation[surface] ?? {})) {
        if (!declared.has(id)) {
          context.addIssue({ code: "custom", path: ["translations", locale, surface, id], message: `No admin ${surface.slice(0, -1)} ${id} to translate.` });
        }
      }
    }
  }
  const needPublicRoute = (path: (string | number)[], route: string) => {
    if (!publicRoutes.has(route)) context.addIssue({ code: "custom", path, message: `Public route ${route} is not declared.` });
  };
  const collections = new Set(Object.keys(manifest.storage));
  // `ctx.storage.batch` is the atomic multi-record write.
  if (collections.has("batch")) {
    context.addIssue({ code: "custom", path: ["storage", "batch"], message: "\"batch\" is reserved: name the collection something else." });
  }
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
  unique(manifest.categories, ["categories"], "Categories");
  unique(manifest.screenshots, ["screenshots"], "Screenshots");
  unique(manifest.countries ?? [], ["countries"], "Countries");
  if (manifest.minPlatformVersion && semverBelow(SCALIUS_PLATFORM_VERSION, manifest.minPlatformVersion)) {
    context.addIssue({
      code: "custom",
      path: ["minPlatformVersion"],
      message: `Needs Scalius ${manifest.minPlatformVersion} or later; this is ${SCALIUS_PLATFORM_VERSION}.`,
    });
  }
  manifest.functions.forEach((fn, index) => {
    if (fn.onError === "block" && !(PLUGIN_BLOCKING_FUNCTION_POINTS as readonly string[]).includes(fn.point)) {
      context.addIssue({ code: "custom", path: ["functions", index, "onError"], message: "Only cart.validate and checkout.payment_methods may block checkout." });
    }
    if (fn.snapshot && fn.point !== "checkout.discounts") {
      context.addIssue({ code: "custom", path: ["functions", index, "snapshot"], message: "Only checkout.discounts reads a snapshot." });
    }
    if (fn.snapshot && !collections.has(fn.snapshot.collection)) {
      context.addIssue({ code: "custom", path: ["functions", index, "snapshot", "collection"], message: `Storage collection ${fn.snapshot.collection} is not declared.` });
    }
  });
  unique(manifest.providers.map((provider) => provider.id), ["providers"], "Provider ids");
  const settingKeys = new Set(manifest.settings.map((field) => field.key));
  manifest.providers.forEach((provider, index) => {
    for (const key of provider.settings ?? []) {
      if (!settingKeys.has(key)) {
        context.addIssue({ code: "custom", path: ["providers", index, "settings"], message: `Setting ${key} is not declared in settings.` });
      }
    }
  });
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
  /** Function points where the app may pause checkout when it cannot answer (`onError: "block"`). */
  blockingFunctions: PluginFunctionPoint[];
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
    blockingFunctions: sorted(manifest.functions.filter((fn) => fn.onError === "block").map((fn) => fn.point)),
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
    || grows(granted.blockingFunctions, next.blockingFunctions)
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
    blockingFunctions: added(granted.blockingFunctions, next.blockingFunctions),
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
