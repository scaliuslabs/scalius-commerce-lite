// Plugin manifest (docs/platform/PLUGINS.md). One strict document says
// everything a plugin may do; the platform derives the consent screen, the
// runtime grants and the dashboard/storefront surfaces from it, so nothing a
// plugin does is undeclared. Validated at every parse site (pack, install,
// load). Part of the versioned plugin API: within `PLUGIN_API_VERSION` it
// changes only additively.

import { z } from "zod";
import { isCustomFieldObjectTarget } from "../custom-fields";
import { isEventTopicFilter, topicMatchesAnyFilter, type EventTopic, type EventTopicFilter } from "../events";
import { SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "./api-version";
import { parsePluginCronSchedule } from "./cron";
import { FIRST_PARTY_PLUGIN_VENDOR, PLUGIN_ID_PATTERN } from "./ids";
import { PLUGIN_HOST_PATTERN, PLUGIN_NAME_PATTERN } from "./manifest-patterns";
import { PLUGIN_SCOPE_NAMES, type PluginScope } from "./scopes";
import { storefrontComponentsManifestSchema } from "./storefront-components";
import { PLUGIN_SETTING_KEY, PLUGIN_STOREFRONT_SETTING_TYPES, pluginAppSettingsSchemaSchema, pluginSettingsSchemaSchema, type PluginSettingsSchema } from "./settings-schema";
import { pluginProvidersSchema } from "./providers/descriptors";
import { checkoutAttributeSchema } from "./buyer-ui";
import { PLUGIN_BLOCK_TARGETS } from "./storefront";
import { objectTypeDeclarationSchema, OBJECT_TYPE_PATTERN } from "./objects";
import { PROVIDER_KINDS } from "./providers/kinds";
import {
  PLUGIN_FEATURES_MAX,
  pluginFeatureIssues,
  pluginFeatureSchema,
  pluginFeatureTranslationSchema,
  pluginManifestWithFeatures,
} from "./features";

/** Date-versioned like the event catalog; a manifest names the version it was built for. */
export { PLUGIN_API_VERSION, SCALIUS_PLATFORM_VERSION, SUPPORTED_PLUGIN_API_VERSIONS, type PluginApiVersion } from "./api-version";

/** `vendor.name` (in ./ids.ts, so id checks don't need this schema module). */
export { FIRST_PARTY_PLUGIN_VENDOR, PLUGIN_ID_PATTERN };
/** Name and host patterns (in ./manifest-patterns.ts, shared with the storefront components contract). */
export { PLUGIN_HOST_PATTERN, PLUGIN_NAME_PATTERN, isPluginHostAllowed } from "./manifest-patterns";
/** Access scopes (in ./scopes.ts: the one scope → RBAC table). */
export {
  PLUGIN_SCOPES,
  PLUGIN_SCOPE_NAMES,
  isPluginScope,
  legacyPermissionScope,
  pluginScopePermissions,
  type PluginScope,
  type PluginScopeDefinition,
} from "./scopes";
/** App features: parts a merchant turns on one at a time (in ./features.ts). */
export {
  PLUGIN_FEATURES_MAX,
  knownPluginFeatures,
  pluginFeatureOwners,
  pluginFeatureRequest,
  pluginManifestWithFeatures,
  type PluginFeature,
  type PluginFeatureInput,
  type PluginFeatureRequest,
} from "./features";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,40})?$/;
const name = z.string().regex(PLUGIN_NAME_PATTERN);
const title = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(500);

// ── Extension points ──────────────────────────────────────────────────────

/** Synchronous decision points: pure input → output, strict limits (functions.ts). */
export const PLUGIN_FUNCTION_POINTS = [
  "cart.transform",
  "cart.line_prices",
  "cart.validate",
  "checkout.discounts",
  "checkout.shipping_rates",
  "checkout.payment_methods",
  "order.risk",
  "buyer.ui",
] as const;
export type PluginFunctionPoint = (typeof PLUGIN_FUNCTION_POINTS)[number];

/**
 * Points where an app may stop checkout when it cannot answer
 * (`onError: "block"`): a check the store relies on (address or stock
 * verification, payment eligibility), the lines a bundle store sells and
 * the prices a B2B store agreed. Elsewhere a failure only leaves the app out.
 */
export const PLUGIN_BLOCKING_FUNCTION_POINTS = [
  "cart.transform",
  "cart.line_prices",
  "cart.validate",
  "checkout.payment_methods",
] as const satisfies readonly PluginFunctionPoint[];

/** Points whose function may read the signed-in buyer's record (`snapshot`); only checkout.discounts may commit it. */
export const PLUGIN_SNAPSHOT_FUNCTION_POINTS = ["cart.line_prices", "checkout.discounts", "buyer.ui"] as const satisfies readonly PluginFunctionPoint[];

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

const scopeName = z.enum(PLUGIN_SCOPE_NAMES);

const adminRouteSchema = routeSchema.extend({
  /**
   * A scope of the app that also gates the staff opening this route: beyond
   * apps.view/apps.use they need the scope's dashboard permission
   * (`PLUGIN_SCOPES[scope].staff`). Must be among the app's `scopes`.
   */
  scope: scopeName.optional(),
});

/**
 * Five-field cron in the store's time zone (cron.ts). The platform checks
 * schedules on its scheduled tick, so a finer schedule runs once per tick.
 */
const cronSchedule = z.string().trim().regex(/^(\S+\s+){4}\S+$/, "Use a five-field cron schedule.")
  .superRefine((value, context) => {
    const parsed = parsePluginCronSchedule(value);
    if (typeof parsed === "string") context.addIssue({ code: "custom", message: parsed });
  });

const customFieldSchema = z.object({
  ownerType: z.enum(["product", "variant", "customer", "order", "category", "collection", "brand", "page"]),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: title,
  /** A custom-field type id from `@scalius/shared/custom-fields`; checked at install. */
  type: z.string().min(1).max(48),
  description: description.optional(),
  storefrontVisible: z.boolean().default(false),
  to: z.string().max(150).optional(),
}).strict().superRefine((field, context) => {
  const isObject = field.type === "object_reference" || field.type === "list.object_reference";
  if (isObject ? !isCustomFieldObjectTarget(field.to) : field.to !== undefined) context.addIssue({ code: "custom", path: ["to"], message: isObject ? "Object references require a qualified target type." : "Only object references declare a target type." });
});

/** The most tabs one app page declares. */
export const PLUGIN_PAGE_TABS_MAX = 8;

/** Dashboard lists an app may add columns and filters to. */
export const PLUGIN_LIST_RESOURCES = ["product", "order", "customer"] as const;
export type PluginListResource = (typeof PLUGIN_LIST_RESOURCES)[number];
/** How a list column shows its value (money: the app stores integer minor units; the list API shows major units). */
export const PLUGIN_LIST_COLUMN_TYPES = ["text", "number", "money", "date", "boolean"] as const;
export type PluginListColumnType = (typeof PLUGIN_LIST_COLUMN_TYPES)[number];
/** The most app columns one list request asks for. */
export const PLUGIN_LIST_COLUMNS_PER_REQUEST = 5;

/**
 * A column the app adds to a dashboard list (Shopify admin list columns),
 * backed by real data: a field of the app's record whose id is the row's
 * resource id, or one of its own custom fields on the resource. The list
 * reads it in one bounded statement for the page shown. `filterable` adds an
 * equality filter, only on a object field that leads one of the
 * collection's declared indexes, so the filter is an index match, never a
 * scan. No app column sorts a list: no index orders the store's rows by an
 * app's value.
 */
const listColumnSchema = z.object({
  id: name,
  resource: z.enum(PLUGIN_LIST_RESOURCES),
  title,
  type: z.enum(PLUGIN_LIST_COLUMN_TYPES),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("object"), object: z.string().regex(OBJECT_TYPE_PATTERN), field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,47}$/) }).strict(),
    z.object({ kind: z.literal("customField"), key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
  ]),
  filterable: z.boolean().default(false),
}).strict();

const adminSchema = z.object({
  /** Full pages; their content is the declarative UI tree the plugin's admin route returns. */
  pages: z.array(z.object({
    id: name,
    title,
    placement: z.enum(PLUGIN_NAV_PLACEMENTS).default("apps"),
    /** The admin route that returns the page's UI tree (with tabs: the first tab's). */
    route: name,
    /**
     * Sub-pages drawn as tabs under the page title (Polaris Tabs), each one
     * its own admin route; the first one opens by default. The page's
     * `route` must be one of them, so a dashboard without tabs still draws
     * the page.
     */
    tabs: z.array(z.object({ id: name, title, route: name }).strict()).min(2).max(PLUGIN_PAGE_TABS_MAX).optional(),
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
  /** Columns (and filters) on the products, orders and customers lists. */
  listColumns: z.array(listColumnSchema).max(10).default([]),
}).strict();

/**
 * Entry kinds the app writes on order timelines (`ctx.timeline.add`), each
 * with the title staff see. Writing needs the `write_orders` scope.
 */
const timelineSchema = z.array(z.object({ kind: name, title }).strict()).max(20).default([])
  .refine((kinds) => new Set(kinds.map((entry) => entry.kind)).size === kinds.length, "Timeline kinds must be unique.");

/** The pages an app script can name. Buyer pages (cart, checkout, the receipt, account) are not among them. */
export const PLUGIN_STOREFRONT_SCRIPT_PAGES = ["all", "home", "product", "listing"] as const;

const storefrontSchema = z.object({
  /**
   * Theme sections the merchant can add in the theme editor/builder: a
   * component the app's storefront module draws at the edge
   * (storefront-components.ts).
   */
  sections: z.array(z.object({
    type: name,
    name: title,
    description: description.optional(),
    settings: pluginSettingsSchemaSchema.default([]),
    reads: z.array(z.object({
      object: z.string().min(2).max(150).regex(/^[a-z][a-z0-9_.-]*$/),
      where: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([
        z.string().max(128), z.number().finite(), z.boolean(), z.null(),
        z.object({ setting: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
      ])).refine((value) => Object.keys(value).length <= 4, "At most four indexed filters.").optional(),
      limit: z.number().int().min(1).max(24).default(24),
    }).strict()).max(2).default([]),
  }).strict()).max(32).default([]),
  /**
   * Blocks inside the product page's purchase area or below it: components
   * the storefront module draws at the edge from the product page's
   * projection (`block` jobs, storefront-components.ts).
   */
  productBlocks: z.array(z.object({
    type: name,
    name: title,
    placement: z.enum(["buy-box", "below"]),
    settings: pluginSettingsSchemaSchema.default([]),
  }).strict()).max(10).default([]),
  /** Meta tags and JSON-LD (sanitized) for the page head. */
  head: z.boolean().default(false),
  /**
   * External scripts; their hosts join the storefront CSP. Loaded non-blocking,
   * on public pages only: app JavaScript never runs on cart, checkout, the receipt or
   * a private page (R3), so those pages cannot be named.
   */
  scripts: z.array(z.object({
    src: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Scripts load over https."),
    placement: z.enum(["head", "body-end"]).default("body-end"),
    pages: z.array(z.enum(PLUGIN_STOREFRONT_SCRIPT_PAGES)).min(1).default(["all"]),
  }).strict()).max(5).default([]),
  /** `/apps/<plugin id>/*` on the storefront origin proxies to the plugin's public routes. */
  proxy: z.boolean().default(false),
  // Storefront components (storefront-components.ts): skins the storefront
  // module draws, ready-made templates, client islands, the stylesheet and
  // the hosts islands reach.
  ...storefrontComponentsManifestSchema,
}).strict();

/** The empty `storefront` part (a manifest that declares none). */
function emptyPluginStorefront() {
  return {
    sections: [], productBlocks: [], head: false, scripts: [], proxy: false,
    skins: [], templates: [], pagePresets: [], islands: [], stylesheet: false, connect: [],
  };
}

/** Whether the app ships a storefront module (component sections, product blocks or skins). */
export function pluginHasStorefrontModule(storefront: Pick<PluginManifest["storefront"], "sections" | "productBlocks" | "skins">): boolean {
  return storefront.skins.length > 0 || storefront.sections.length > 0 || storefront.productBlocks.length > 0;
}

/** A setting a component cannot resolve without a read: images and products (the theme's sections read them; skins and blocks read nothing). */
function settingNeedsRead(field: PluginSettingsSchema[number]): boolean {
  return field.type === "image" || field.type === "products" || field.type === "product"
    || (field.type === "list" && field.fields.some((item) => item.type === "image"));
}

// ── Settings groups ───────────────────────────────────────────────────────

/** The most app-wide settings sections one app declares. */
export const PLUGIN_SETTINGS_GROUPS_MAX = 20;

/**
 * An app-wide section of the app's settings page (Polaris: a titled card of
 * related fields). Fields join one with `settings[].group`; provider-scoped
 * fields are shown with their provider instead.
 */
const settingsGroupSchema = z.object({
  id: name,
  title,
  description: description.optional(),
  /** Lower comes first; groups with the same order keep the manifest's order. */
  order: z.number().int().min(0).max(1000).default(100),
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
/** Data updates a manifest may declare. */
export const PLUGIN_MIGRATIONS_MAX = 200;

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

/**
 * A translation key: a BCP 47 tag as the store and dashboard write it
 * (`bn`, `fr`, `pt-BR`, `zh-Hant-TW`). English is the manifest itself.
 */
export const PLUGIN_TRANSLATION_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
/** Languages one app may translate into. */
export const PLUGIN_TRANSLATIONS_MAX = 20;

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
  salesChannels: z.record(name, title).optional(),
  actions: z.record(name, title).optional(),
  widgets: z.record(name, title).optional(),
  /** List column titles by id. */
  listColumns: z.record(name, title).optional(),
  /** Order timeline entry titles by kind. */
  timeline: z.record(name, title).optional(),
  /** Page tab titles: page id → tab id → title. */
  tabs: z.record(name, z.record(name, title)).optional(),
  /** Settings section titles and descriptions by group id. */
  settingsGroups: z.record(name, z.object({ title: title.optional(), description: description.optional() }).strict()).optional(),
  /** Setting labels, help and option labels by stored value (app settings only). */
  settings: z.record(z.string().regex(PLUGIN_SETTING_KEY), z.object({
    label: z.string().trim().min(1).max(80).optional(),
    help: z.string().trim().min(1).max(280).optional(),
    options: z.record(z.string().min(1).max(64), z.string().trim().min(1).max(80)).optional(),
  }).strict()).optional(),
  /** Feature names and descriptions by feature id. */
  features: z.record(name, pluginFeatureTranslationSchema).optional(),
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

  /**
   * Store data and actions the app asks for (`PLUGIN_SCOPES`): every
   * `ctx.api` call, timeline write and customer message is checked against
   * the approved ones. These are the base scopes; a feature asks for its own
   * when a person turns it on (`features[].scopes`).
   */
  scopes: z.array(scopeName).max(PLUGIN_SCOPE_NAMES.length).default([])
    .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique."),
  /** Outbound hosts for `ctx.http.fetch` (none means no network). */
  allowedHosts: z.array(z.string().toLowerCase().regex(PLUGIN_HOST_PATTERN)).max(20).default([]),

  events: z.array(z.string().refine(isEventTopicFilter, "Unknown event topic.")).max(40).default([])
    .transform((topics) => topics as EventTopicFilter[]),
  functions: z.array(z.object({
    point: z.enum(PLUGIN_FUNCTION_POINTS),
    targets: z.array(z.enum(PLUGIN_BLOCK_TARGETS)).min(1).max(9).optional(),
    /** Lower runs first among plugins at the same point. */
    priority: z.number().int().min(0).max(1000).default(100),
    /**
     * What a throw, timeout or invalid answer does: `skip` leaves the app out
     * (fail open); `block` stops checkout with the store's buyer-safe message
     * (PLUGIN_BLOCKING_FUNCTION_POINTS only).
     */
    onError: z.enum(["skip", "block"]).default("skip"),
    /**
     * checkout.discounts and cart.line_prices: the signed-in buyer's record
     * in this collection (record id = customer id) is passed in as
     * `snapshot` (a B2B contract, a subscription, a points balance). A
     * checkout.discounts answer may `commit` a new version of it, written
     * with the order in the same atomic batch at the revision the function
     * saw (a spent balance can never be spent twice).
     */
    snapshot: z.object({ object: z.string().regex(OBJECT_TYPE_PATTERN) }).strict().optional(),
  }).strict()).max(PLUGIN_FUNCTION_POINTS.length).default([]),
  /**
   * Providers the app implements, grouped by port (providers/descriptors.ts).
   * Ids are unique within the app; merchants and orders name a provider
   * `<plugin id>:<id>`.
   */
  checkout: z.object({ attributes: z.array(checkoutAttributeSchema).max(10).refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, "Attribute keys must be unique.") }).strict().optional(),
  providers: pluginProvidersSchema,

  routes: z.object({
    /** Dashboard-authenticated (`/api/v1/plugins/<id>/admin/<name>`). */
    admin: z.array(adminRouteSchema).max(40).default([]),
    /** Unauthenticated, rate-limited (`/api/v1/plugins/<id>/public/<name>`). */
    public: z.array(routeSchema).max(20).default([]),
    /** Inbound provider webhooks (`/api/v1/plugins/<id>/webhooks/<name>`), raw body preserved. */
    webhooks: z.array(name).max(10).default([]),
  }).strict().default({ admin: [], public: [], webhooks: [] }),
  cron: z.array(z.object({ name, schedule: cronSchedule }).strict()).max(10).default([]),

  objects: z.record(z.string().regex(OBJECT_TYPE_PATTERN), objectTypeDeclarationSchema).default({})
    .refine((types) => Object.keys(types).length <= 20, "At most 20 object types."),
  customFields: z.array(customFieldSchema).max(50).default([]),
  /**
   * Versioned data updates of the app's own storage (`migrations` handlers,
   * keyed by version). The platform runs each one once, in order, before the
   * app's next run after an install or update, and records it per app; a
   * rollback never reverses one. Append only: never renumber or remove one.
   */
  migrations: z.array(z.object({
    version: z.number().int().min(1).max(10_000),
    description: z.string().trim().min(1).max(200),
  }).strict()).max(PLUGIN_MIGRATIONS_MAX).default([]),
  /**
   * Sales channels the app sells through (Shopify's sales-channel apps,
   * MARKETS-DESIGN D6): each becomes the channel `<plugin id>:<id>`, on while
   * the app is active. Merchants publish products to it (Products, the
   * product page's Publishing card); the app reads them from
   * `GET /api/v1/admin/settings/sales-channels/<channel id>/products` and
   * follows `product.publication_changed`. Its orders name it.
   */
  salesChannels: z.array(z.object({ id: name, name: title }).strict()).max(3).default([])
    .refine((channels) => new Set(channels.map((channel) => channel.id)).size === channels.length, "Sales channel ids must be unique."),
  settings: pluginAppSettingsSchemaSchema.default([]),
  /**
   * Parts of the app a merchant turns on one at a time (features.ts). Each
   * starts off; turning one on asks consent for its own scopes and hosts, and
   * only then do its providers, routes, jobs, events and surfaces run.
   */
  features: z.array(pluginFeatureSchema).max(PLUGIN_FEATURES_MAX).default([]),
  /** App-wide settings sections (`settings[].group`); additive, presentation only. */
  settingsGroups: z.array(settingsGroupSchema).max(PLUGIN_SETTINGS_GROUPS_MAX).default([]),

  admin: adminSchema.default({ pages: [], cards: [], actions: [], widgets: [], listColumns: [] }),
  timeline: timelineSchema,
  storefront: storefrontSchema.default(emptyPluginStorefront),
  /** The dashboard text in other languages (additive; English is the manifest itself). */
  translations: z.record(z.string().regex(PLUGIN_TRANSLATION_LOCALE_PATTERN, "Use a BCP 47 language tag such as bn or pt-BR."), pluginTranslationSchema).optional()
    .refine((translations) => translations === undefined || Object.keys(translations).length <= PLUGIN_TRANSLATIONS_MAX, `Translate into ${PLUGIN_TRANSLATIONS_MAX} languages or fewer.`),

  /** Per-invocation limits, within the platform's ceilings. */
  limits: z.object({
    cpuMs: z.number().int().min(5).max(200).default(50),
    wallMs: z.number().int().min(100).max(30_000).default(10_000),
  }).strict().default({ cpuMs: 50, wallMs: 10_000 }),
}).strict().superRefine((manifest, context) => {
  const featureScopes = new Set(manifest.features.flatMap((feature) => feature.scopes));
  manifest.routes.admin.forEach((route, index) => {
    if (route.scope && !manifest.scopes.includes(route.scope) && !featureScopes.has(route.scope)) {
      context.addIssue({ code: "custom", path: ["routes", "admin", index, "scope"], message: "An admin route scope must be among the app's scopes." });
    }
  });
  for (const issue of pluginFeatureIssues(manifest)) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  const routes = new Set([...manifest.routes.admin, ...manifest.routes.public].map((route) => route.name));
  const adminRoutes = new Set(manifest.routes.admin.map((route) => route.name));
  const publicRoutes = new Set(manifest.routes.public.map((route) => route.name));
  if (routes.size !== manifest.routes.admin.length + manifest.routes.public.length) {
    context.addIssue({ code: "custom", path: ["routes"], message: "Route names must be unique across admin and public routes." });
  }
  const needAdminRoute = (path: (string | number)[], route: string) => {
    if (!adminRoutes.has(route)) context.addIssue({ code: "custom", path, message: `Admin route ${route} is not declared.` });
  };
  manifest.admin.pages.forEach((page, index) => {
    needAdminRoute(["admin", "pages", index, "route"], page.route);
    if (!page.tabs) return;
    page.tabs.forEach((tab, tabIndex) => needAdminRoute(["admin", "pages", index, "tabs", tabIndex, "route"], tab.route));
    if (new Set(page.tabs.map((tab) => tab.id)).size !== page.tabs.length) {
      context.addIssue({ code: "custom", path: ["admin", "pages", index, "tabs"], message: "Tab ids must be unique." });
    }
    if (!page.tabs.some((tab) => tab.route === page.route)) {
      context.addIssue({ code: "custom", path: ["admin", "pages", index, "route"], message: "A page with tabs draws one of them: use a tab's route." });
    }
  });
  manifest.admin.cards.forEach((card, index) => needAdminRoute(["admin", "cards", index, "route"], card.route));
  manifest.admin.actions.forEach((action, index) => needAdminRoute(["admin", "actions", index, "route"], action.route));
  manifest.admin.widgets.forEach((widget, index) => needAdminRoute(["admin", "widgets", index, "route"], widget.route));
  for (const [locale, translation] of Object.entries(manifest.translations ?? {})) {
    for (const surface of ["pages", "cards", "actions", "widgets", "listColumns"] as const) {
      const declared = new Set(manifest.admin[surface].map((entry) => entry.id));
      for (const id of Object.keys(translation[surface] ?? {})) {
        if (!declared.has(id)) {
          context.addIssue({ code: "custom", path: ["translations", locale, surface, id], message: `No admin ${surface.slice(0, -1)} ${id} to translate.` });
        }
      }
    }
    const timelineKinds = new Set(manifest.timeline.map((entry) => entry.kind));
    for (const kind of Object.keys(translation.timeline ?? {})) {
      if (!timelineKinds.has(kind)) context.addIssue({ code: "custom", path: ["translations", locale, "timeline", kind], message: `No timeline kind ${kind} to translate.` });
    }
    const salesChannelIds = new Set(manifest.salesChannels.map((channel) => channel.id));
    for (const id of Object.keys(translation.salesChannels ?? {})) {
      if (!salesChannelIds.has(id)) context.addIssue({ code: "custom", path: ["translations", locale, "salesChannels", id], message: `No sales channel ${id} to translate.` });
    }
    for (const [pageId, tabs] of Object.entries(translation.tabs ?? {})) {
      const page = manifest.admin.pages.find((entry) => entry.id === pageId);
      for (const tabId of Object.keys(tabs)) {
        if (!page?.tabs?.some((tab) => tab.id === tabId)) {
          context.addIssue({ code: "custom", path: ["translations", locale, "tabs", pageId, tabId], message: `No tab ${tabId} on page ${pageId} to translate.` });
        }
      }
    }
    const featureIds = new Set(manifest.features.map((feature) => feature.id));
    for (const id of Object.keys(translation.features ?? {})) {
      if (!featureIds.has(id)) context.addIssue({ code: "custom", path: ["translations", locale, "features", id], message: `No feature ${id} to translate.` });
    }
    const groups = new Set(manifest.settingsGroups.map((group) => group.id));
    for (const id of Object.keys(translation.settingsGroups ?? {})) {
      if (!groups.has(id)) context.addIssue({ code: "custom", path: ["translations", locale, "settingsGroups", id], message: `No settings group ${id} to translate.` });
    }
    for (const [key, text] of Object.entries(translation.settings ?? {})) {
      const field = manifest.settings.find((entry) => entry.key === key);
      const path = ["translations", locale, "settings", key];
      if (!field) {
        context.addIssue({ code: "custom", path, message: `No setting ${key} to translate.` });
      } else if (text.options !== undefined) {
        if (field.type !== "select" && field.type !== "multiselect") {
          context.addIssue({ code: "custom", path: [...path, "options"], message: "Only select and multiselect settings have option labels." });
        } else {
          for (const value of Object.keys(text.options)) {
            if (!field.options.some((option) => option.value === value)) context.addIssue({ code: "custom", path: [...path, "options", value], message: `No option ${value} on setting ${key} to translate.` });
          }
        }
      }
    }
  }
  const collections = new Set(Object.keys(manifest.objects));
  // `ctx.objects.batch` is the atomic multi-record write.
  if (collections.has("batch")) {
    context.addIssue({ code: "custom", path: ["objects", "batch"], message: "\"batch\" is reserved: name the collection something else." });
  }
  // Components (sections and product blocks): public settings the storefront module resolves at the edge.
  const components = [
    ...manifest.storefront.sections.map((surface, index) => ({ settings: surface.settings, path: ["storefront", "sections", index] as (string | number)[], reads: true })),
    ...manifest.storefront.productBlocks.map((surface, index) => ({ settings: surface.settings, path: ["storefront", "productBlocks", index] as (string | number)[], reads: false })),
  ];
  const storefrontOnly = new Set<string>(PLUGIN_STOREFRONT_SETTING_TYPES);
  for (const { settings, path, reads } of components) {
    settings.forEach((field, fieldIndex) => {
      if (field.type === "secret") {
        context.addIssue({ code: "custom", path: [...path, "settings", fieldIndex, "type"], message: "Storefront settings are public: keep secrets in the app's settings." });
      }
      if (field.group !== undefined) {
        context.addIssue({ code: "custom", path: [...path, "settings", fieldIndex, "group"], message: "Groups are for the app's own settings." });
      }
      // A product block draws from the product page's projection alone: no media or catalog read.
      if (!reads && settingNeedsRead(field)) {
        context.addIssue({ code: "custom", path: [...path, "settings", fieldIndex, "type"], message: "A product block's settings cannot name images or products (ship images in the app's public files)." });
      }
    });
  }
  manifest.settings.forEach((field, index) => {
    if (storefrontOnly.has(field.type)) {
      context.addIssue({ code: "custom", path: ["settings", index, "type"], message: `${field.type} settings are for storefront components, not the app's own settings.` });
    }
  });
  manifest.storefront.skins.forEach((skin, index) => {
    skin.settings.forEach((field, fieldIndex) => {
      const path = ["storefront", "skins", index, "settings", fieldIndex];
      if (field.type === "secret") context.addIssue({ code: "custom", path: [...path, "type"], message: "Storefront settings are public: keep secrets in the app's settings." });
      if (field.group !== undefined) context.addIssue({ code: "custom", path: [...path, "group"], message: "Groups are for the app's own settings." });
      // A skin draws from its unit's projection alone: its settings resolve at the edge, without a media or catalog read.
      if (settingNeedsRead(field)) context.addIssue({ code: "custom", path: [...path, "type"], message: "A skin's settings cannot name images or products (ship images in the app's public files)." });
    });
  });
  if (manifest.storefront.proxy && publicRoutes.size === 0) {
    context.addIssue({ code: "custom", path: ["storefront", "proxy"], message: "The storefront proxy needs at least one public route." });
  }
  const unique = (values: string[], path: (string | number)[], what: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path, message: `${what} must be unique.` });
  };
  unique(manifest.functions.map((fn) => fn.point), ["functions"], "Function points");
  manifest.migrations.forEach((migration, index) => {
    const previous = manifest.migrations[index - 1];
    if (previous && migration.version <= previous.version) {
      context.addIssue({ code: "custom", path: ["migrations", index, "version"], message: "Migration versions must increase." });
    }
  });
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
    if ((fn.point === "buyer.ui") !== Boolean(fn.targets?.length)) context.addIssue({ code: "custom", path: ["functions", index, "targets"], message: "Only buyer.ui declares targets, and it requires at least one." });
    if (fn.onError === "block" && !(PLUGIN_BLOCKING_FUNCTION_POINTS as readonly string[]).includes(fn.point)) {
      context.addIssue({ code: "custom", path: ["functions", index, "onError"], message: `Only ${PLUGIN_BLOCKING_FUNCTION_POINTS.join(", ")} may block checkout.` });
    }
    if (fn.snapshot && !(PLUGIN_SNAPSHOT_FUNCTION_POINTS as readonly string[]).includes(fn.point)) {
      context.addIssue({ code: "custom", path: ["functions", index, "snapshot"], message: `Only ${PLUGIN_SNAPSHOT_FUNCTION_POINTS.join(" and ")} read a snapshot.` });
    }
    if (fn.snapshot && !collections.has(fn.snapshot.object)) {
      context.addIssue({ code: "custom", path: ["functions", index, "snapshot", "object"], message: `Object type ${fn.snapshot.object} is not declared.` });
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
    if (provider.environmentSetting !== undefined) {
      const field = manifest.settings.find((candidate) => candidate.key === provider.environmentSetting);
      const values = field?.type === "select" ? field.options.map((option) => option.value).sort().join(",") : "";
      if (values !== "live,sandbox") {
        context.addIssue({ code: "custom", path: ["providers", index, "environmentSetting"], message: `Setting ${provider.environmentSetting} must be a select of sandbox and live.` });
      }
    }
  });
  unique(manifest.settingsGroups.map((group) => group.id), ["settingsGroups"], "Settings group ids");
  const providerIds = new Set(manifest.providers.map((provider) => provider.id));
  manifest.settingsGroups.forEach((group, index) => {
    if (providerIds.has(group.id)) {
      context.addIssue({ code: "custom", path: ["settingsGroups", index, "id"], message: `${group.id} is a provider id: provider fields join their provider with group: "${group.id}".` });
    }
  });
  const groupIds = new Set(manifest.settingsGroups.map((group) => group.id));
  manifest.settings.forEach((field, index) => {
    if (field.group !== undefined && !groupIds.has(field.group) && !providerIds.has(field.group)) {
      context.addIssue({ code: "custom", path: ["settings", index, "group"], message: `Group ${field.group} is neither a settings group nor a provider id.` });
    }
  });
  unique(manifest.cron.map((job) => job.name), ["cron"], "Cron names");
  unique(manifest.customFields.map((field) => `${field.ownerType}:${field.key}`), ["customFields"], "Custom field keys");
  unique(manifest.admin.listColumns.map((column) => `${column.resource}:${column.id}`), ["admin", "listColumns"], "List column ids");
  manifest.admin.listColumns.forEach((column, index) => {
    const path = ["admin", "listColumns", index];
    if (column.source.kind === "customField") {
      const key = column.source.key;
      if (!manifest.customFields.some((field) => field.ownerType === column.resource && field.key === key)) {
        context.addIssue({ code: "custom", path: [...path, "source", "key"], message: `Custom field ${column.resource}.${key} is not declared.` });
      }
      if (column.filterable) context.addIssue({ code: "custom", path: [...path, "filterable"], message: "Only a object field an index leads can filter a list." });
      return;
    }
    const collection = manifest.objects[column.source.object];
    if (!collection) {
      context.addIssue({ code: "custom", path: [...path, "source", "object"], message: `Object type ${column.source.object} is not declared.` });
      return;
    }
    const field = column.source.field;
    const leads = collection.indexes.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === field);
    if (column.filterable && !leads) {
      context.addIssue({ code: "custom", path: [...path, "filterable"], message: `Index ${field} first in collection ${column.source.object} to filter by it.` });
    }
  });
  unique(manifest.storefront.sections.map((section) => section.type), ["storefront", "sections"], "Section types");
  unique(manifest.storefront.skins.map((skin) => skin.id), ["storefront", "skins"], "Skin ids");
  unique(manifest.storefront.templates.map((template) => template.id), ["storefront", "templates"], "Template ids");
  unique(manifest.storefront.pagePresets.map((preset) => preset.id), ["storefront", "pagePresets"], "Page preset ids");
  unique(manifest.storefront.islands.map((island) => island.name), ["storefront", "islands"], "Island names");
  unique(manifest.storefront.connect, ["storefront", "connect"], "Connect hosts");
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

/**
 * Whether this platform can run a manifest, before the full parse: the
 * plugin API version it was built for (`apiVersion`, one of
 * `SUPPORTED_PLUGIN_API_VERSIONS`) and the oldest platform release it needs
 * (`minPlatformVersion`). Install, activation and update refuse an
 * incompatible manifest (the parse refuses it too); the Apps page shows why.
 */
export function pluginCompatibility(value: unknown):
  | { ok: true }
  | { ok: false; reason: "api_version" | "platform_version"; message: string } {
  const raw = (typeof value === "object" && value !== null ? value : {}) as { apiVersion?: unknown; minPlatformVersion?: unknown };
  if (typeof raw.apiVersion !== "string" || !(SUPPORTED_PLUGIN_API_VERSIONS as readonly string[]).includes(raw.apiVersion)) {
    return {
      ok: false,
      reason: "api_version",
      message: `Built for plugin API ${typeof raw.apiVersion === "string" ? raw.apiVersion : "(none)"}; this Scalius supports ${SUPPORTED_PLUGIN_API_VERSIONS.join(", ")}.`,
    };
  }
  if (typeof raw.minPlatformVersion === "string" && SEMVER.test(raw.minPlatformVersion) && semverBelow(SCALIUS_PLATFORM_VERSION, raw.minPlatformVersion)) {
    return {
      ok: false,
      reason: "platform_version",
      message: `Needs Scalius ${raw.minPlatformVersion} or later; this is ${SCALIUS_PLATFORM_VERSION}.`,
    };
  }
  return { ok: true };
}

// ── Consent ───────────────────────────────────────────────────────────────

/**
 * Everything a manifest asks for, grouped for the consent screen. A grant
 * records exactly this; an update whose `grantKey` differs needs approval
 * again.
 */
export interface PluginGrantRequest {
  /** Access scopes (`PLUGIN_SCOPES`). */
  scopes: PluginScope[];
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
  /**
   * Runs code on the storefront: a storefront module (component sections and
   * product blocks, skins), client islands or a stylesheet. Present only when true, so the
   * grants of apps without components keep their key.
   */
  storefrontCode?: true;
  /** Hosts the app's islands reach from the buyer's browser. Present only when not empty. */
  storefrontConnect?: string[];
  /**
   * The features turned on (`manifest.features`), sorted. Present only when
   * the app declares features, so the grants of apps without keep their key.
   * Everything else in the request already includes these features' parts.
   */
  features?: string[];
}

/**
 * What the app asks for with `features` on (default: none, the base). Pass the
 * manifest as declared, or the running manifest with the same features it
 * runs with (`pluginManifestWithFeatures` is idempotent for a given set).
 */
export function pluginGrantRequest(declared: PluginManifest, features: Iterable<string> = []): PluginGrantRequest {
  const sorted = <T extends string>(values: Iterable<T>) => [...new Set(values)].sort();
  const wanted = new Set(features);
  const enabled = sorted(declared.features.map((feature) => feature.id).filter((id) => wanted.has(id)));
  const manifest = pluginManifestWithFeatures(declared, enabled);
  return {
    scopes: sorted(manifest.scopes),
    allowedHosts: sorted(manifest.allowedHosts),
    events: sorted(manifest.events),
    functions: sorted(manifest.functions.map((fn) => fn.point)),
    blockingFunctions: sorted(manifest.functions.filter((fn) => fn.onError === "block").map((fn) => fn.point)),
    providers: sorted(manifest.providers.map((provider) => provider.kind)),
    publicRoutes: manifest.routes.public.length > 0 || manifest.routes.webhooks.length > 0 || manifest.storefront.proxy,
    storefrontScripts: sorted(manifest.storefront.scripts.map((script) => new URL(script.src).host)),
    storefrontSurfaces: manifest.storefront.sections.length > 0 || manifest.storefront.productBlocks.length > 0
      || manifest.storefront.head || manifest.storefront.skins.length > 0,
    customFieldOwners: sorted(manifest.customFields.map((field) => field.ownerType)),
    ...(pluginHasStorefrontModule(manifest.storefront) || manifest.storefront.islands.length > 0 || manifest.storefront.stylesheet
      ? { storefrontCode: true as const }
      : {}),
    ...(manifest.storefront.connect.length > 0 ? { storefrontConnect: sorted(manifest.storefront.connect) } : {}),
    ...(declared.features.length > 0 ? { features: enabled } : {}),
  };
}

/** A stable key of a grant request: equal keys need no new approval. */
export function pluginGrantKey(request: PluginGrantRequest): string {
  return JSON.stringify(request);
}

/** Whether `next` asks for anything `granted` did not (a narrower update needs no approval). */
export function pluginGrantExpands(granted: PluginGrantRequest, next: PluginGrantRequest): boolean {
  const grows = (before: readonly string[], after: readonly string[]) => after.some((value) => !before.includes(value));
  return grows(granted.scopes, next.scopes)
    || grows(granted.allowedHosts, next.allowedHosts)
    || next.events.some((filter) => !eventFilterCovered(filter, granted.events))
    || grows(granted.functions, next.functions)
    || grows(granted.blockingFunctions, next.blockingFunctions)
    || grows(granted.providers, next.providers)
    || (!granted.publicRoutes && next.publicRoutes)
    || grows(granted.storefrontScripts, next.storefrontScripts)
    || (!granted.storefrontSurfaces && next.storefrontSurfaces)
    || grows(granted.customFieldOwners, next.customFieldOwners)
    || (!granted.storefrontCode && next.storefrontCode === true)
    || grows(granted.storefrontConnect ?? [], next.storefrontConnect ?? [])
    || grows(granted.features ?? [], next.features ?? []);
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
    scopes: added(granted.scopes, next.scopes),
    allowedHosts: added(granted.allowedHosts, next.allowedHosts),
    events: next.events.filter((filter) => !eventFilterCovered(filter, granted.events)),
    functions: added(granted.functions, next.functions),
    blockingFunctions: added(granted.blockingFunctions, next.blockingFunctions),
    providers: added(granted.providers, next.providers),
    publicRoutes: next.publicRoutes && !granted.publicRoutes,
    storefrontScripts: added(granted.storefrontScripts, next.storefrontScripts),
    storefrontSurfaces: next.storefrontSurfaces && !granted.storefrontSurfaces,
    customFieldOwners: added(granted.customFieldOwners, next.customFieldOwners),
    ...(next.storefrontCode && !granted.storefrontCode ? { storefrontCode: true as const } : {}),
    ...(added(granted.storefrontConnect ?? [], next.storefrontConnect ?? []).length > 0
      ? { storefrontConnect: added(granted.storefrontConnect ?? [], next.storefrontConnect ?? []) }
      : {}),
    ...(next.features !== undefined ? { features: added(granted.features ?? [], next.features) } : {}),
  };
}

/** Whether a topic filter asks for nothing beyond the granted filters. */
function eventFilterCovered(filter: EventTopicFilter, granted: readonly EventTopicFilter[]): boolean {
  if (granted.includes("*") || granted.includes(filter)) return true;
  if (filter === "*" || filter.endsWith(".*")) return false;
  return topicMatchesAnyFilter(filter as EventTopic, granted);
}
