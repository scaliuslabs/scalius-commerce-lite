// Admin OpenAPI routes for installed apps (plugins, docs/platform/PLUGINS.md):
// the list (bundled plugins appear as installed automatically), one app's
// detail with its consent request in structured form, activation (Super Admin
// approves the grant), its features (each off until a Super Admin turns it on
// and approves that feature's access; anyone who manages apps turns one
// off), settings (secrets write-only), deactivation,
// uninstall (keep or delete data), the plugin log and event deliveries, and
// the listing images (icon, screenshots) of installed and catalogued apps.
// RBAC: apps.view / apps.manage (route-permissions/apps.ts); plugins can
// never call these (the `apps` resource is reserved, and they are
// security-class operations).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { user as userTable, PLUGIN_EVENT_DELIVERY_STATUSES } from "@scalius/database/schema";
import {
  PLUGIN_DELIVERY_LIST_MAX_LIMIT,
  describePluginSettings,
  effectivePluginPermissions,
  isFirstPartyBundledPlugin,
  isOfficialPluginKey,
  isThirdPartyPlugin,
  pluginRegistrySettingsDocument,
  trustedPluginKeys,
  latestPluginCronRuns,
  listPluginEventDeliveries,
  listPluginInstallations,
  readPluginInstallations,
  listPluginLogs,
  pluginNeedsApproval,
  requirePluginInstallation,
  retryPluginEventDelivery,
  writePluginSettings,
  type PluginEventDeliveryView,
  type PluginInstallation,
  type UnreadablePluginInstallation,
} from "@scalius/core/modules/plugins";
import { PERMISSION_METADATA } from "@scalius/core/auth/rbac/permission-metadata";
import {
  PLUGIN_ADMIN_TARGETS,
  PLUGIN_LIST_COLUMN_TYPES,
  PLUGIN_LIST_RESOURCES,
  PLUGIN_CATEGORIES,
  PLUGIN_ID_PATTERN,
  PLUGIN_FUNCTION_POINTS,
  PLUGIN_NAV_PLACEMENTS,
  PLUGIN_SCOPE_NAMES,
  STOREFRONT_COMPONENT_TARGETS,
  STOREFRONT_UI_SLOTS,
  isSensitivePluginScope,
  knownPluginFeatures,
  pluginFeatureOwners,
  pluginFeatureRequest,
  pluginGrantAdditions,
  pluginGrantKey,
  pluginGrantRequest,
  pluginHasStorefrontModule,
  appSettingsSections,
  providerOwnSettingKeys,
  providerSettingKeys,
  type PluginGrantRequest,
  type PluginManifest,
  functionReadKey,
  type FunctionReadDeclaration,
  type FunctionReadKey,
} from "@scalius/shared/plugins";
import { PROVIDER_KINDS, qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { STOREFRONT_INCIDENT_REASONS } from "@scalius/shared/plugins/storefront-incidents";
import { appSettingField, appSettingFieldSchema, appSettingValueSchema, providerConnectionSchema } from "../../schemas/app-settings";
import { ConflictError, ForbiddenError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { afterResponse, executionContextOf } from "../../background/after-response";
import { BUNDLED_PLUGINS } from "../../plugins/bundled.gen";
import { PLUGIN_CATALOG } from "../../plugins/catalog.gen";
import {
  PLUGIN_ASSET_NAME,
  compiledPluginAsset,
  listingDetail,
  listingSummary,
  pluginAssetKey,
  pluginAssetPath,
  pluginAssetResponse,
  providerIconUrl,
} from "../../plugins/listing";
import { syncBundledPlugin, syncBundledPlugins } from "../../plugins/bundled-sync";
import { providerUse, putServicesToUse } from "../../plugins/provider-adoption";
import { providerConnections } from "../../plugins/provider-connection";

import { isPluginSandboxAvailable } from "../../plugins/loaders/sandbox-availability";
import { planLimits } from "@scalius/shared/plan-limits";
import { storefrontAppThemeProblems } from "@scalius/shared/storefront-theme/app-templates";
import { STOREFRONT_PAGE_TEMPLATES } from "@scalius/shared/storefront-theme/pages";
import { STOREFRONT_THEME_APP_PARTS_MAX, storefrontThemeAppParts, storefrontThemeAppReferences } from "@scalius/shared/storefront-theme/app-references";
import type { Database } from "@scalius/database/client";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { getThemeSettings } from "@scalius/core/modules/settings";
import { registerAppLifecycleRoutes } from "./apps-lifecycle";
import { registerRemovedAppDataRoutes } from "./apps-removed-data";

// The plugin host with its lifecycle hooks and the operation catalogue (risk
// per permission) load only on the requests that need them, never when this
// route family starts.
const lifecycle = () => import("../../plugins/lifecycle");

function sandboxAvailable(c: Context<{ Bindings: Env }>): boolean {
  try {
    return isPluginSandboxAvailable(c.env, c.executionCtx as unknown as ExecutionContext);
  } catch {
    return false;
  }
}

const app = new OpenAPIHono<{ Bindings: Env }>();

/** Log lines per page (the ring keeps a plugin's newest 500). */
const APP_LOG_PAGE_MAX = 100;

const isoOrNull = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function noStore(c: { header(name: string, value: string): void }) {
  c.header("Cache-Control", "private, no-store");
}

// ── Schemas ──

/** One declared read of a function or extension, as the dashboard lists it. */
const appReadSchema = z.object({
  as: z.string(),
  object: z.string().nullable().openapi({ description: "The app's object type read; null for a custom-field read." }),
  customFields: z.array(z.string()).openapi({ description: "The app's own custom fields read (`<owner>:<key>`); empty for an object read." }),
  key: z.string().openapi({ description: "What the read is keyed by: customer, line.variantId, line.productId, attribute.<key>, or from:<read>.<field>." }),
});

const grantSchema = z.object({
  scopes: z.array(z.enum(PLUGIN_SCOPE_NAMES)).openapi({ description: "Access scopes: store data and actions the app may read or change." }),
  allowedHosts: z.array(z.string()),
  events: z.array(z.string()),
  functions: z.array(z.string()),
  extensions: z.array(z.string()).openapi({ description: "UI slots of the buyer's cart, checkout, receipt and account pages the app shows content in." }),
  blockingFunctions: z.array(z.string()).openapi({ description: "Function points where the app may pause checkout when it cannot answer." }),
  providers: z.array(z.string()),
  publicRoutes: z.boolean(),
  storefrontScripts: z.array(z.string()),
  storefrontSurfaces: z.boolean(),
  customFieldOwners: z.array(z.string()),
  storefrontCode: z.boolean().openapi({ description: "Draws on the storefront with its own code: components, client islands or a stylesheet." }),
  storefrontConnect: z.array(z.string()).openapi({ description: "Hosts the app's storefront islands reach from the buyer's browser." }),
  features: z.array(z.string()).openapi({ description: "The app's features that are on (empty for apps that declare none)." }),
  messageRecipients: z.array(z.string()).openapi({ description: "Fields of the app's own records (<object>.<field>) whose email addresses or phone numbers it may message." }),
}).openapi("AppGrant", { description: "What an app may do; the consent screen lists it in plain words." });

/** The manifest's text in other languages (BCP 47 tag → text); the dashboard picks its own. */
const appTranslationsSchema = z.record(z.string(), z.object({
    name: z.string().optional(),
    tagline: z.string().optional(),
    description: z.string().optional(),
    pages: z.record(z.string(), z.string()).optional(),
    cards: z.record(z.string(), z.string()).optional(),
    actions: z.record(z.string(), z.string()).optional(),
    widgets: z.record(z.string(), z.string()).optional(),
    listColumns: z.record(z.string(), z.string()).optional(),
    timeline: z.record(z.string(), z.string()).optional(),
    tabs: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    settingsGroups: z.record(z.string(), z.object({ title: z.string().optional(), description: z.string().optional() })).optional(),
    settings: z.record(z.string(), z.object({ label: z.string().optional(), help: z.string().optional(), options: z.record(z.string(), z.string()).optional() })).optional(),
    features: z.record(z.string(), z.object({ name: z.string().optional(), description: z.string().optional() })).optional(),
  })).nullable().openapi("AppTranslations", { description: "Name, tagline, description and surface titles by BCP 47 language tag (null: English only)." });

/** What every app card shows besides its name, before and after install. */
const listingSummaryFields = {
  tagline: z.string().nullable().openapi({ description: "One line under the name." }),
  icon: z.string().nullable().openapi({ description: "Same-origin address of the app's icon (SVG or PNG), or null." }),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).openapi({ description: "One to three categories; the first is the main one." }),
  countries: z.array(z.string()).nullable().openapi({ description: "ISO 3166-1 alpha-2 codes of the countries the app serves; null: every country." }),
};

/** What an app's page adds: screenshots, help and policy links, and the oldest platform release it runs on. */
const listingDetailFields = {
  screenshots: z.array(z.string()).openapi({ description: "Same-origin addresses of up to six screenshots." }),
  support: z.object({ url: z.string().nullable(), email: z.string().nullable() }).nullable(),
  privacyPolicyUrl: z.string().nullable(),
  documentationUrl: z.string().nullable(),
  changelogUrl: z.string().nullable(),
  minPlatformVersion: z.string().nullable(),
};

const appListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  translations: appTranslationsSchema.optional(),
  author: z.object({ name: z.string(), url: z.string().nullable() }),
  homepage: z.string().nullable(),
  ...listingSummaryFields,
  ...listingDetailFields,
  installCommand: z.string().openapi({ description: "The operator's command that bundles this app (then deploy)." }),
}).openapi("AppListing", { description: "A first-party app this deployment does not bundle yet." });

const appSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  translations: appTranslationsSchema.optional(),
  author: z.object({ name: z.string(), url: z.string().nullable() }),
  homepage: z.string().nullable(),
  ...listingSummaryFields,
  source: z.enum(["bundled", "registry", "upload"]),
  status: z.enum(["installed", "active", "disabled", "failed"]),
  needsApproval: z.boolean().openapi({ description: "An update asks for more access than was approved; the app waits until a Super Admin approves it." }),
  thirdParty: z.boolean().openapi({ description: "Not published by Scalius: the emergency switch for third-party apps stops it." }),
  signed: z.boolean().openapi({ description: "Its code was verified against a trusted developer key (registry or signed upload); bundled code is the operator's own." }),
  failureReason: z.string().nullable(),
  revision: z.number().int(),
  installedAt: z.string(),
  activatedAt: z.string().nullable(),
  updatedAt: z.string(),
  featureCount: z.object({
    on: z.number().int(),
    total: z.number().int(),
  }).openapi({ description: "How many of the app's features are on, of how many it declares (0 of 0: an app without features)." }),
  functions: z.array(z.object({
    point: z.enum(PLUGIN_FUNCTION_POINTS),
    priority: z.number().int().openapi({ description: "Lower runs first among apps at the same point." }),
    onError: z.enum(["skip", "block"]).openapi({ description: "block: the app pauses checkout when it cannot answer (needs approval)." }),
    reads: z.array(appReadSchema).openapi({ description: "The app's data the function reads at checkout (checkout.discounts may also update those records with the order)." }),
  })).openapi({ description: "The checkout function points the app implements (cart rules, prices, discounts, delivery options, payment methods)." }),
  extensions: z.array(z.object({
    target: z.enum(STOREFRONT_UI_SLOTS),
    reads: z.array(appReadSchema).openapi({ description: "The app's data the extension reads to draw its content." }),
  })).openapi({ description: "Where the app shows content on the buyer's cart, checkout, receipt and account pages (storefront extensions)." }),
}).openapi("AppSummary");

const settingValueSchema = appSettingValueSchema;
const settingFieldSchema = appSettingFieldSchema;

const routeSchema = z.object({ name: z.string(), methods: z.array(z.string()) });

/** An app page's tabs (each its own admin route); null: one page. */
const pageTabsSchema = z.array(z.object({ id: z.string(), title: z.string(), route: z.string() })).nullable();

const appPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  placement: z.enum(PLUGIN_NAV_PLACEMENTS),
  route: z.string(),
  tabs: pageTabsSchema,
});

/** A provider the app offers, where the merchant sets it up (its capability's settings page). */
const appProviderEntrySchema = z.object({
  id: z.string().openapi({ description: "<plugin id>:<provider id>, as the capability's settings store it." }),
  providerId: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  name: z.string(),
  icon: z.string().nullable().openapi({ description: "Same-origin address of the provider's own mark, else the app's icon." }),
}).openapi("AppProviderEntry");

const scopeRowSchema = z.object({
  name: z.enum(PLUGIN_SCOPE_NAMES),
  risk: z.enum(["read", "write", "destructive", "financial"]).openapi({ description: "The highest risk among the operations the scope lets this app call." }),
  sensitive: z.boolean().openapi({ description: "The scope reaches sensitive data or settings." }),
});

/** One part of the app a merchant turns on by itself (`manifest.features`). */
const appFeatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  recommended: z.boolean().openapi({ description: "Suggested during setup; it still starts off." }),
  request: z.object({
    scopes: z.array(scopeRowSchema).openapi({ description: "Store access this feature adds, for its consent dialog." }),
    allowedHosts: z.array(z.string()).openapi({ description: "Outside services this feature talks to." }),
    providers: z.array(z.object({ id: z.string(), kind: z.enum(PROVIDER_KINDS), name: z.string(), icon: z.string().nullable() })),
    events: z.array(z.string()),
    functions: z.array(z.string()),
    publicRoutes: z.boolean().openapi({ description: "Receives requests from outside the dashboard (webhooks, public routes)." }),
    storefront: z.boolean().openapi({ description: "Adds to the storefront." }),
    admin: z.boolean().openapi({ description: "Adds pages, cards or actions to the dashboard." }),
    cron: z.array(z.string()).openapi({ description: "Scheduled jobs it runs." }),
  }).openapi({ description: "What turning this feature on asks for: only the feature's own part, never the app's base." }),
  grantKey: z.string().nullable().openapi({ description: "Send back to turn it on (the access shown); null while it is on." }),
  settings: z.array(z.string()).openapi({ description: "The setting keys that belong to this feature (its providers' and settings groups' fields); the app lists them in `settings.fields` only while it is on." }),
  pages: z.array(z.string()).openapi({ description: "The ids of the dashboard pages (`admin.pages`) this feature adds while it is on." }),
}).openapi("AppFeature");

/** A part of the store's theme an app draws, where it sits and the app's name for it. */
const themeAppPartSchema = z.object({
  kind: z.enum(["section", "section_skin", "skin", "product_block"]).openapi({
    description: "A section the app draws, the app's skin of a store section, a skin of a store unit (header, footer, product card, product page, listing), or a product-page app block.",
  }),
  type: z.string().openapi({ description: "The app's section type, skin id or component type." }),
  target: z.string().optional().openapi({ description: "A skin's target: the unit, or section:<store section type>." }),
  path: z.string().openapi({ description: "The theme document path of the reference." }),
  place: z.object({
    page: z.enum(["home", "landing", "template", "theme"]),
    slug: z.string().optional().openapi({ description: "A landing page's handle." }),
    template: z.enum(STOREFRONT_PAGE_TEMPLATES).optional(),
    index: z.number().int().nonnegative().optional().openapi({ description: "The section's or block's position, from 0." }),
  }),
  name: z.string().optional().openapi({ description: "The app's name for the part; absent when it no longer declares it." }),
}).openapi("ThemeAppPart");

const appDetailSchema = appSummarySchema.extend({
  ...listingDetailFields,
  grantKey: z.string().openapi({ description: "Send back on activation: approving a request nobody was shown is refused." }),
  request: grantSchema,
  granted: grantSchema.nullable(),
  added: grantSchema.openapi({ description: "What the request adds to the approved grant (everything before the first approval)." }),
  scopes: z.array(scopeRowSchema).openapi({ description: "The requested scopes, for the consent screen." }),
  features: z.array(appFeatureSchema).openapi({ description: "Parts of the app turned on one at a time; each starts off. Off features' providers, settings, routes and jobs do not run and are not listed here." }),
  activatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  runtime: z.enum(["bundled", "sandbox"]),
  runtimeAvailable: z.boolean(),
  settings: z.object({
    fields: z.array(settingFieldSchema),
    values: z.record(z.string(), settingValueSchema),
    secrets: z.record(z.string(), z.boolean()).openapi({ description: "Whether each secret is set; secret values are never returned." }),
    missing: z.array(z.string()).openapi({ description: "Required settings still empty (activation needs them)." }),
    sections: z.array(z.object({
      group: z.object({ id: z.string(), title: z.string(), description: z.string().nullable() }).nullable(),
      keys: z.array(z.string()),
    })).openapi({ description: "The app-wide settings in their sections, in order (group null: general). Provider fields show with their provider." }),
  }),
  providers: z.array(appProviderEntrySchema.extend({
    settings: z.array(z.string()).openapi({ description: "The setting keys shown with the provider where it is set up." }),
    own: z.boolean().openapi({ description: "Whether the provider has fields of its own (otherwise it uses the app's general settings)." }),
    required: z.array(z.string()).openapi({ description: "The keys its readiness needs set: its declared settings, else the app's required ones." }),
    connection: providerConnectionSchema,
    use: z.enum(["offered", "hidden", "currency", "chosen", "not_chosen"]).nullable().openapi({
      description: "Whether the store uses it: a payment method checkout lists (offered), one hidden in Settings, Payments (hidden) or one that cannot charge the store currency (currency); the notification SMS service (chosen) or another one (not_chosen). Null for other kinds.",
    }),
  })).openapi({ description: "The providers the app offers, each set up on its capability's settings page." }),
  routes: z.object({ admin: z.array(routeSchema), public: z.array(routeSchema), webhooks: z.array(routeSchema) }),
  cron: z.array(z.object({
    name: z.string(),
    schedule: z.string(),
    lastRun: z.object({
      scheduledFor: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      finishedAt: z.string().nullable(),
      durationMs: z.number().int().nullable(),
      error: z.string().nullable(),
    }).nullable(),
  })),
  objects: z.array(z.string()),
  customFields: z.array(z.object({ ownerType: z.string(), key: z.string(), name: z.string(), type: z.string() })),
  storefront: z.object({
    proxy: z.boolean(),
    head: z.boolean(),
    sections: z.array(z.object({ type: z.string(), name: z.string() })),
    components: z.array(z.object({ type: z.string(), name: z.string(), targets: z.array(z.enum(STOREFRONT_COMPONENT_TARGETS)) })),
    /** Designs (skins) of the store's own parts: a unit (`header`, `product_card`) or a core section (`section:<type>`). */
    skins: z.array(z.object({ id: z.string(), name: z.string(), target: z.string() })),
    scripts: z.array(z.object({ src: z.string(), placement: z.string(), pages: z.array(z.string()) })),
    themeProblems: z.array(z.object({
      kind: z.enum(["template", "page-preset"]),
      id: z.string(),
      name: z.string(),
      problem: z.string(),
    })).openapi({ description: "Templates and page presets the store's theme cannot use after upgrading them from the version they were written for; the theme editor leaves them out." }),
  }),
  admin: z.object({
    pages: z.array(appPageSchema),
    cards: z.array(z.object({ id: z.string(), target: z.enum(PLUGIN_ADMIN_TARGETS), title: z.string() })),
    actions: z.array(z.object({ id: z.string(), target: z.enum(PLUGIN_ADMIN_TARGETS), label: z.string(), bulk: z.boolean() })),
    widgets: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  limits: z.object({
    cpuMs: z.number().int(),
    wallMs: z.number().int(),
    subrequests: z.number().int().openapi({ description: "Platform calls per run." }),
    invocationsPerMinute: z.number().int(),
    storageBytes: z.number().int().openapi({ description: "The most its storage may hold." }),
  }).openapi({ description: "What one run may use: the app's own limits within the plan's." }),
  storageUsage: z.object({
    bytes: z.number().int(),
    measuredAt: z.string().nullable(),
  }).openapi({ description: "Its stored data at the last daily measurement." }),
  signer: z.object({ keyId: z.string(), name: z.string().nullable(), official: z.boolean() }).nullable()
    .openapi({ description: "The developer key that verified its code; null for bundled code and unsigned uploads." }),
  migrations: z.object({
    declared: z.array(z.object({ version: z.number().int(), description: z.string() })),
    applied: z.number().int().openapi({ description: "The newest data update that ran." }),
  }),
  themeUsage: z.object({
    parts: z.array(themeAppPartSchema).max(STOREFRONT_THEME_APP_PARTS_MAX),
    more: z.number().int().nonnegative().openapi({ description: "Parts left out of the list." }),
  }).openapi({
    description: "The parts of the published theme this app draws (hidden sections left out): while the app is not active, the storefront shows the store's own design there instead.",
  }),
}).openapi("AppDetail");

const appDeliverySchema = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  topic: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  status: z.enum(PLUGIN_EVENT_DELIVERY_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi("AppEventDelivery");

const appLogLineSchema = z.object({
  id: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
}).openapi("AppLogLine");

// ── Presenters ──

function summary(installation: PluginInstallation) {
  const { manifest } = installation;
  return {
    id: installation.pluginId,
    name: manifest.name,
    version: installation.version,
    description: manifest.description,
    translations: manifest.translations ?? null,
    author: { name: manifest.author.name, url: manifest.author.url ?? null },
    homepage: manifest.homepage ?? null,
    ...listingSummary(installation.pluginId, manifest, installation.bundleSha256),
    source: installation.source,
    status: installation.status,
    needsApproval: pluginNeedsApproval(installation),
    thirdParty: isThirdPartyPlugin(installation),
    signed: installation.signerKeyId !== null,
    failureReason: installation.failureReason,
    revision: installation.revision,
    installedAt: iso(installation.installedAt),
    activatedAt: isoOrNull(installation.activatedAt),
    updatedAt: iso(installation.updatedAt),
    featureCount: {
      on: knownPluginFeatures(installation.declaredManifest, installation.features).length,
      total: installation.declaredManifest.features.length,
    },
    functions: manifest.functions.map((fn) => ({
      point: fn.point,
      priority: fn.priority,
      onError: fn.onError,
      reads: fn.reads.map(readRow),
    })),
    extensions: manifest.storefront.extensions.map((extension) => ({ target: extension.target, reads: extension.reads.map(readRow) })),
  };
}

function readRow(read: FunctionReadDeclaration) {
  return {
    as: read.as,
    object: "object" in read ? read.object : null,
    customFields: "customFields" in read ? read.customFields : [],
    key: readKeyLabel(functionReadKey(read)),
  };
}

/** A read's key as one label: `from:<read>.<field>` for a hop. */
function readKeyLabel(key: FunctionReadKey): string {
  return typeof key === "object" ? `from:${key.from}` : key;
}

const settingField = appSettingField;

function pageEntry(page: PluginManifest["admin"]["pages"][number]) {
  return {
    id: page.id,
    title: page.title,
    placement: page.placement,
    route: page.route,
    tabs: page.tabs ? page.tabs.map((tab) => ({ id: tab.id, title: tab.title, route: tab.route })) : null,
  };
}

function providerEntry(installation: PluginInstallation, provider: PluginManifest["providers"][number]) {
  return {
    id: qualifiedProviderId(installation.pluginId, provider.id),
    providerId: provider.id,
    kind: provider.kind,
    name: provider.name,
    icon: providerIconUrl(installation.pluginId, installation.declaredManifest, provider.id, installation.bundleSha256),
  };
}

function missingSettings(installation: PluginInstallation, described: ReturnType<typeof describePluginSettings>): string[] {
  return installation.manifest.settings
    .filter((field) => field.required)
    .filter((field) => {
      if (field.type === "secret") return !described.secrets[field.key];
      const value = described.values[field.key];
      return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    })
    .map((field) => field.key);
}

/** Each requested scope with the highest risk among the operations it lets this app (in its tier) call. */
async function scopeRows(installation: PluginInstallation, request: Pick<PluginGrantRequest, "scopes">) {
  const { derivePluginRiskCeiling } = await import("../../plugins/authority");
  const firstParty = isFirstPartyBundledPlugin(installation);
  return request.scopes.map((name) => {
    const permissions = effectivePluginPermissions({ scopes: [name] });
    const risk = derivePluginRiskCeiling(permissions, firstParty);
    return {
      name,
      risk: (risk === "security" ? "financial" : risk) as "read" | "write" | "destructive" | "financial",
      // Buyer contact data (a protected customer data scope) and mail to any address are always sensitive.
      sensitive: isSensitivePluginScope(name)
        || [...permissions].some((permission) => (PERMISSION_METADATA as Record<string, { isSensitive?: boolean }>)[permission]?.isSensitive === true),
    };
  });
}

function runtimeAvailable(c: Context<{ Bindings: Env }>, installation: PluginInstallation): boolean {
  if (installation.source === "bundled") return Object.prototype.hasOwnProperty.call(BUNDLED_PLUGINS, installation.pluginId);
  return sandboxAvailable(c);
}

/** Each declared feature with its state and what turning it on asks for. */
async function featureRows(installation: PluginInstallation) {
  const declared = installation.declaredManifest;
  const owners = pluginFeatureOwners(declared);
  const owned = (map: Map<string, string>, id: string) => [...map].filter(([, owner]) => owner === id).map(([key]) => key);
  const pageIds = new Set(declared.admin.pages.map((page) => page.id));
  return Promise.all(declared.features.map(async (feature) => {
    const enabled = installation.features.includes(feature.id);
    const request = pluginFeatureRequest(declared, feature.id)!;
    return {
      id: feature.id,
      name: feature.name,
      description: feature.description,
      enabled,
      recommended: feature.recommended,
      request: {
        ...request,
        scopes: await scopeRows(installation, request),
        providers: request.providers.map((provider) => ({
          id: qualifiedProviderId(installation.pluginId, provider.id),
          kind: provider.kind as (typeof PROVIDER_KINDS)[number],
          name: provider.name,
          icon: providerIconUrl(installation.pluginId, declared, provider.id, installation.bundleSha256),
        })),
      },
      grantKey: enabled ? null : pluginGrantKey(pluginGrantRequest(declared, [...installation.features, feature.id])),
      settings: owned(owners.settings, feature.id),
      pages: feature.admin.filter((id) => pageIds.has(id)),
    };
  }));
}

/**
 * The parts of the published theme an app draws, named by its manifest. An
 * unreadable published theme renders the store's default, which names no app.
 */
async function themeUsage(db: Database, installation: PluginInstallation) {
  const theme = await getThemeSettings(db).then((published) => published.theme, (error: unknown) => {
    if (error instanceof ServiceUnavailableError) return null;
    throw error;
  });
  if (!theme) return { parts: [], more: 0 };
  const references = storefrontThemeAppReferences(theme)
    .filter((reference) => reference.pluginId === installation.pluginId && !reference.hidden);
  return storefrontThemeAppParts(references, [{ pluginId: installation.pluginId, manifest: installation.declaredManifest }]);
}

async function detail(c: Context<{ Bindings: Env }>, installation: PluginInstallation) {
  const db = c.get("db");
  const { manifest } = installation;
  const request = pluginGrantRequest(installation.declaredManifest, installation.features);
  const described = describePluginSettings(installation);
  const caps = planLimits().plugins;
  const [approver, lastRuns, scopes, registrySettings, features, uses, connections, usage] = await Promise.all([
    installation.activatedBy
      ? db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.id, installation.activatedBy)).get()
      : Promise.resolve(undefined),
    latestPluginCronRuns(db, installation.pluginId, manifest.cron.map((job) => job.name)),
    scopeRows(installation, request),
    installation.signerKeyId ? pluginRegistrySettingsDocument.read(db) : Promise.resolve({ registries: [], trustedKeys: [] }),
    featureRows(installation),
    providerUse(db, installation),
    providerConnections(db, installation, manifest.providers),
    themeUsage(db, installation),
  ]);
  const available = runtimeAvailable(c, installation);
  return {
    ...summary(installation),
    ...listingDetail(installation.pluginId, manifest, installation.bundleSha256),
    grantKey: pluginGrantKey(request),
    request,
    granted: installation.grant,
    added: pluginGrantAdditions(installation.grant, request),
    scopes,
    features,
    activatedBy: approver ? { id: approver.id, name: approver.name } : null,
    runtime: installation.source === "bundled" ? "bundled" as const : "sandbox" as const,
    runtimeAvailable: available,
    settings: {
      fields: manifest.settings.map(settingField),
      values: described.values,
      secrets: described.secrets,
      missing: missingSettings(installation, described),
      sections: appSettingsSections(manifest),
    },
    providers: manifest.providers.map((provider) => ({
      ...providerEntry(installation, provider),
      settings: providerSettingKeys(manifest, provider.id),
      own: providerOwnSettingKeys(manifest, provider.id).length > 0,
      required: provider.settings ? [...provider.settings] : manifest.settings.filter((field) => field.required).map((field) => field.key),
      connection: connections.get(qualifiedProviderId(installation.pluginId, provider.id))!,
      use: uses.get(qualifiedProviderId(installation.pluginId, provider.id)) ?? null,
    })),
    routes: {
      admin: manifest.routes.admin.map((route) => ({ name: route.name, methods: [...route.methods] })),
      public: manifest.routes.public.map((route) => ({ name: route.name, methods: [...route.methods] })),
      webhooks: manifest.routes.webhooks.map((route) => ({ name: route.name, methods: [...route.methods] })),
    },
    cron: manifest.cron.map((job) => {
      const run = lastRuns[job.name] ?? null;
      return {
        name: job.name,
        schedule: job.schedule,
        lastRun: run
          ? {
            scheduledFor: iso(run.scheduledFor),
            status: run.status,
            finishedAt: isoOrNull(run.finishedAt),
            durationMs: run.durationMs,
            error: run.error,
          }
          : null,
      };
    }),
    objects: Object.keys(manifest.objects),
    customFields: manifest.customFields.map((field) => ({ ownerType: field.ownerType, key: field.key, name: field.name, type: field.type })),
    storefront: {
      proxy: manifest.storefront.proxy,
      head: manifest.storefront.head,
      sections: manifest.storefront.sections.map((section) => ({ type: section.type, name: section.name })),
      components: manifest.storefront.components.map((component) => ({ type: component.type, name: component.name, targets: [...component.targets] })),
      skins: manifest.storefront.skins.map((skin) => ({ id: skin.id, name: skin.name, target: skin.target })),
      scripts: manifest.storefront.scripts.map((script) => ({ src: script.src, placement: script.placement, pages: [...script.pages] })),
      themeProblems: storefrontAppThemeProblems(manifest.storefront),
    },
    admin: {
      pages: manifest.admin.pages.map(pageEntry),
      cards: manifest.admin.cards.map((card) => ({ id: card.id, target: card.target, title: card.title })),
      actions: manifest.admin.actions.map((action) => ({ id: action.id, target: action.target, label: action.label, bulk: action.bulk })),
      widgets: manifest.admin.widgets.map((widget) => ({ id: widget.id, title: widget.title })),
    },
    limits: {
      cpuMs: Math.min(manifest.limits.cpuMs, caps.cpuMs),
      wallMs: Math.min(manifest.limits.wallMs, caps.wallMs),
      subrequests: caps.subrequests,
      invocationsPerMinute: caps.invocationsPerMinute,
      storageBytes: caps.storageBytes,
    },
    storageUsage: { bytes: installation.storageBytes, measuredAt: isoOrNull(installation.storageMeasuredAt) },
    signer: installation.signerKeyId
      ? {
        keyId: installation.signerKeyId,
        name: trustedPluginKeys(registrySettings).find((key) => key.id === installation.signerKeyId)?.name ?? null,
        official: isOfficialPluginKey(installation.signerKeyId),
      }
      : null,
    migrations: {
      declared: manifest.migrations.map((migration) => ({ version: migration.version, description: migration.description })),
      applied: installation.migratedVersion,
    },
    themeUsage: usage,
  };
}

function deliveryResponse(view: PluginEventDeliveryView) {
  return {
    id: view.id,
    eventId: view.eventId,
    topic: view.topic,
    resourceType: view.resourceType,
    resourceId: view.resourceId,
    status: view.status,
    attempts: view.attempts,
    maxAttempts: view.maxAttempts,
    durationMs: view.durationMs,
    error: view.error,
    nextAttemptAt: isoOrNull(view.nextAttemptAt),
    lastAttemptAt: isoOrNull(view.lastAttemptAt),
    deliveredAt: isoOrNull(view.deliveredAt),
    createdAt: iso(view.createdAt),
  };
}

function lifecycleContext(c: Context<{ Bindings: Env }>) {
  let ctx: ExecutionContext;
  try {
    ctx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  }
  return { db: c.get("db"), env: c.env, ctx };
}

/** The app as stored, after bringing a bundled one in step with the deployed code. */
async function loadApp(c: Context<{ Bindings: Env }>, id: string): Promise<PluginInstallation> {
  const db = c.get("db");
  await syncBundledPlugin(db, id);
  return requirePluginInstallation(db, id);
}

const idParams = z.object({ id: z.string().regex(PLUGIN_ID_PATTERN).openapi({ description: "The app's id (vendor.name)." }) });
const revisionSchema = z.number().int().min(1).openapi({ description: "The app's current revision (every change advances it)." });

const readErrors = {
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
} as const;
const mutationErrors = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  503: serviceUnavailableResponse,
} as const;

// ── List ──

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.apps.list",
  tags: ["Admin - Apps"],
  summary: "List installed apps",
  description: "Apps compiled into this deployment appear as installed (not running) until a Super Admin activates them.",
  responses: {
    200: {
      description: "Installed apps",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            apps: z.array(appSummarySchema),
            available: z.array(appListingSchema).openapi({ description: "First-party apps not bundled into this deployment: each installs with its installCommand, then a deploy." }),
            sandboxAvailable: z.boolean(),
          })),
        },
      },
    },
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(listRoute, async (c) => {
  noStore(c);
  const db = c.get("db");
  await syncBundledPlugins(db);
  const { installations, unreadable } = await readPluginInstallations(db);
  const apps = [...installations.map(summary), ...unreadable.map(unreadableSummary)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const installed = new Set(apps.map((entry) => entry.id));
  const available = PLUGIN_CATALOG.filter((entry) => !installed.has(entry.id)).map(catalogListing);
  return ok(c, { apps, available, sandboxAvailable: sandboxAvailable(c) });
});

/**
 * An installed app whose saved manifest this release cannot read: it cannot
 * run, so it is listed as failed with the reason instead of vanishing from
 * the page (a bundled one is rewritten from the deployed code by the sync).
 */
function unreadableSummary(installation: UnreadablePluginInstallation): ReturnType<typeof summary> {
  return {
    id: installation.pluginId,
    name: installation.name ?? installation.pluginId,
    version: installation.version,
    description: "",
    translations: null,
    author: { name: "", url: null },
    homepage: null,
    tagline: null,
    icon: null,
    categories: [],
    countries: null,
    source: installation.source,
    status: "failed",
    needsApproval: false,
    thirdParty: isThirdPartyPlugin(installation),
    signed: false,
    failureReason: installation.failureReason
      ?? `Reinstall needed: this release cannot read the saved version ${installation.version} of this app, so it is not running.`,
    revision: installation.revision,
    installedAt: iso(installation.installedAt),
    activatedAt: isoOrNull(installation.activatedAt),
    updatedAt: iso(installation.updatedAt),
    featureCount: { on: 0, total: 0 },
    functions: [],
    extensions: [],
  };
}

function catalogListing(entry: (typeof PLUGIN_CATALOG)[number]) {
  const { listing } = entry;
  return {
    id: entry.id,
    name: listing.name,
    version: listing.version,
    description: listing.description,
    translations: listing.translations ?? null,
    author: { name: listing.author.name, url: listing.author.url ?? null },
    homepage: listing.homepage ?? null,
    ...listingSummary(entry.id, listing, entry.sha256),
    ...listingDetail(entry.id, listing, entry.sha256),
    installCommand: `pnpm plugin add ${entry.source}`,
  };
}

// ── Listing images ──

const assetRoute = createRoute({
  method: "get",
  path: "/{id}/assets/{asset}",
  operationId: "dashboard.apps.asset_get",
  tags: ["Admin - Apps"],
  summary: "Read an app's icon, one of its screenshots or a provider's icon",
  description: "The image the listing names, checked again before it is served (an SVG cannot run code or load anything). A `v` equal to the app's current fingerprint is cached for a year.",
  request: {
    params: idParams.extend({ asset: z.string().regex(PLUGIN_ASSET_NAME).openapi({ description: "icon, screenshot-1 to screenshot-6, or provider-<provider id>." }) }),
    query: z.object({ v: z.string().max(64).optional().openapi({ description: "The fingerprint from the listing's address." }) }),
  },
  responses: {
    200: {
      description: "The image",
      content: {
        "image/svg+xml": { schema: z.string().openapi({ format: "binary" }) },
        "image/png": { schema: z.string().openapi({ format: "binary" }) },
        "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
        "image/webp": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...readErrors,
  },
});

app.openapi(assetRoute, async (c) => {
  const { id, asset } = c.req.valid("param");
  const version = c.req.valid("query").v ?? "";
  const missing = () => new Response(JSON.stringify({ success: false, error: { code: "not_found", message: "Image not found" } }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
  const installation = await requirePluginInstallation(c.get("db"), id).catch(() => null);
  let response: Response | null = null;
  if (installation) {
    // Off features' provider marks too: the features list shows them.
    const target = pluginAssetPath(installation.declaredManifest, asset);
    if (!target) return missing();
    const current = version.length >= 16 && installation.bundleSha256.startsWith(version);
    if (installation.source === "bundled") {
      // The deployed images belong to the deployed code; another installed version is not cached.
      const deployed = Object.hasOwn(BUNDLED_PLUGINS, id) && BUNDLED_PLUGINS[id]!.sha256 === installation.bundleSha256;
      const bytes = await compiledPluginAsset(id, target.path);
      if (bytes) response = pluginAssetResponse(bytes, target.path, target.role, current && deployed);
    } else {
      const object = await c.env.BUCKET.get(pluginAssetKey(id, installation.version, installation.bundleSha256, target.path));
      if (object && "arrayBuffer" in object) response = pluginAssetResponse(new Uint8Array(await object.arrayBuffer()), target.path, target.role, current);
    }
  } else {
    const entry = PLUGIN_CATALOG.find((candidate) => candidate.id === id);
    const target = entry ? pluginAssetPath(entry.listing, asset) : null;
    const bytes = entry && target ? await compiledPluginAsset(id, target.path) : null;
    if (entry && target && bytes) {
      response = pluginAssetResponse(bytes, target.path, target.role, version.length >= 16 && entry.sha256.startsWith(version));
    }
  }
  return response ?? missing();
});

// ── Dashboard surfaces of active apps ──

const surfaceRouteSchema = z.object({
  name: z.string(),
  methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
});

const appAdminSurfacesSchema = z.object({
  id: z.string(),
  name: z.string(),
  pages: z.array(appPageSchema),
  cards: z.array(z.object({ id: z.string(), target: z.enum(PLUGIN_ADMIN_TARGETS), title: z.string(), route: z.string() })),
  actions: z.array(z.object({
    id: z.string(),
    target: z.enum(PLUGIN_ADMIN_TARGETS),
    label: z.string(),
    route: z.string(),
    bulk: z.boolean(),
    destructive: z.boolean(),
  })),
  widgets: z.array(z.object({ id: z.string(), title: z.string(), route: z.string() })),
  /** Columns (and filters) on the products, orders and customers lists; ask for them with appColumns / appFilter. */
  listColumns: z.array(z.object({
    key: z.string().openapi({ description: "<app id>/<column id>: what appColumns and appFilter name." }),
    id: z.string(),
    resource: z.enum(PLUGIN_LIST_RESOURCES),
    title: z.string(),
    type: z.enum(PLUGIN_LIST_COLUMN_TYPES),
    filterable: z.boolean(),
  })),
  /** The app's admin routes: buttons and forms in its UI may call only these, with these methods. */
  routes: z.array(surfaceRouteSchema),
  /** Its providers: dashboard search opens each one's setup where its capability lives. */
  providers: z.array(appProviderEntrySchema),
  translations: appTranslationsSchema.optional(),
}).openapi("AppAdminSurfaces");

const surfacesRoute = createRoute({
  method: "get",
  path: "/surfaces",
  operationId: "dashboard.apps.surfaces",
  tags: ["Admin - Apps"],
  summary: "List what active apps add to the dashboard",
  description: "Pages (navigation entries, with their tabs), resource cards, actions, home widgets and providers of every active app, from their manifests. Their content comes from each app's own admin routes.",
  responses: {
    200: {
      description: "Dashboard surfaces of active apps",
      content: { "application/json": { schema: successEnvelope(z.object({ apps: z.array(appAdminSurfacesSchema) })) } },
    },
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(surfacesRoute, async (c) => {
  noStore(c);
  const installations = await listPluginInstallations(c.get("db"));
  const apps = installations
    .filter((installation) => installation.status === "active" && installation.grant !== null)
    .map((installation) => {
      const { admin, routes, name, translations } = installation.manifest;
      return {
        id: installation.pluginId,
        name,
        pages: admin.pages.map(pageEntry),
        cards: admin.cards.map((card) => ({ id: card.id, target: card.target, title: card.title, route: card.route })),
        actions: admin.actions.map((action) => ({
          id: action.id,
          target: action.target,
          label: action.label,
          route: action.route,
          bulk: action.bulk,
          destructive: action.destructive,
        })),
        widgets: admin.widgets.map((widget) => ({ id: widget.id, title: widget.title, route: widget.route })),
        listColumns: admin.listColumns.map((column) => ({
          key: `${installation.pluginId}/${column.id}`,
          id: column.id,
          resource: column.resource,
          title: column.title,
          type: column.type,
          filterable: column.filterable,
        })),
        routes: routes.admin.map((route) => ({ name: route.name, methods: [...route.methods] })),
        providers: installation.manifest.providers.map((provider) => providerEntry(installation, provider)),
        translations: translations ?? null,
      };
    })
    .filter((surfaces) => surfaces.pages.length + surfaces.cards.length + surfaces.actions.length + surfaces.widgets.length
      + surfaces.listColumns.length + surfaces.providers.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return ok(c, { apps });
});

// ── Storefront problems (before `/{id}`) ──

const storefrontProblemSchema = z.object({
  /** The app. */
  id: z.string(),
  /** What the store could not show, why, and what it showed instead (the app's log line). */
  message: z.string(),
  kind: z.enum(["section", "component", "skin"]).nullable(),
  /** The section type, component type or skin id. */
  type: z.string().nullable(),
  /** A component's slot or a skin's target (`product_card`, `section:usp_strip`). */
  target: z.string().nullable(),
  /** Why: the store cannot run this version here, the app answered late, its code failed, what it drew broke the limits, or it left the part out. */
  reason: z.enum(STOREFRONT_INCIDENT_REASONS).nullable(),
  at: z.string(),
}).openapi("AppStorefrontProblem");

const storefrontProblemsRoute = createRoute({
  method: "get",
  path: "/storefront-problems",
  operationId: "dashboard.apps.storefront_problems_list",
  tags: ["Admin - Apps"],
  summary: "List apps whose storefront parts the store recently drew without",
  description: "The newest storefront render problem of each installed app with storefront parts in the last 24 hours: a section, block or skin a page was drawn without (unavailable, late, failed or refused), as written in the app's log. Pages never fail because of it; the store draws its own instead.",
  responses: {
    200: {
      description: "Recent storefront problems, newest first",
      content: { "application/json": { schema: successEnvelope(z.object({ problems: z.array(storefrontProblemSchema) })) } },
    },
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(storefrontProblemsRoute, async (c) => {
  noStore(c);
  const db = c.get("db");
  const installations = await listPluginInstallations(db);
  const withStorefront = installations.filter((installation) => pluginHasStorefrontModule(installation.manifest.storefront));
  const { recentStorefrontProblems } = await import("../../plugins/storefront-incidents");
  const problems = await recentStorefrontProblems(db, withStorefront.map((installation) => installation.pluginId));
  const kinds = new Set(["section", "component", "skin"]);
  return ok(c, {
    problems: problems.map((problem) => ({
      id: problem.pluginId,
      message: problem.message,
      kind: problem.kind !== null && kinds.has(problem.kind) ? problem.kind as "section" | "component" | "skin" : null,
      type: problem.type,
      target: problem.target,
      reason: problem.reason,
      at: iso(problem.at),
    })),
  });
});

// ── Registry, upload, update and emergency stop (apps-lifecycle.ts; before `/{id}`) ──

registerAppLifecycleRoutes(app, { detail, detailSchema: appDetailSchema, lifecycleContext: lifecycleContext as never });

// ── Data from removed apps (apps-removed-data.ts; before `/{id}`) ──

registerRemovedAppDataRoutes(app);

// ── Get ──

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "dashboard.apps.get",
  tags: ["Admin - Apps"],
  summary: "Get one app: what it asks to access, its settings and its jobs",
  request: { params: idParams },
  responses: {
    200: { description: "The app", content: { "application/json": { schema: successEnvelope(z.object({ app: appDetailSchema })) } } },
    ...readErrors,
  },
});

app.openapi(getRoute, async (c) => {
  noStore(c);
  const installation = await loadApp(c, c.req.valid("param").id);
  return ok(c, { app: await detail(c, installation) });
});

// ── Activate (approve the grant) ──

const activateRoute = createRoute({
  method: "post",
  path: "/{id}/activate",
  operationId: "dashboard.apps.activate",
  tags: ["Admin - Apps"],
  summary: "Approve an app's access and start it (Super Admin)",
  description: "Records the approved grant and the approving Super Admin; the app's API writes are recorded as theirs. Runs the app's install (first time) and activate hooks; a failing hook is reported, not fatal.",
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ expectedRevision: revisionSchema, grantKey: z.string().min(2).max(65_536) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Active",
      content: { "application/json": { schema: successEnvelope(z.object({ app: appDetailSchema, hookError: z.string().nullable() })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(activateRoute, async (c) => {
  noStore(c);
  const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
  // Consent is a person's: a Super Admin in the dashboard, never an agent or a plugin.
  if (!actor?.id || actor.isSuperAdmin !== true || c.get("agentPrincipal") || c.get("pluginPrincipal")) {
    throw new ForbiddenError("Only a Super Admin can approve an app's access.");
  }
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const current = await loadApp(c, id);
  if (!runtimeAvailable(c, current)) {
    throw new ConflictError(current.source === "bundled"
      ? "This app's code is not in this deployment. Add it with pnpm plugin add, then deploy."
      : "Sandboxed apps need Workers Paid with the plugin sandbox turned on.");
  }
  const { activatePluginWithHooks } = await lifecycle();
  const result = await activatePluginWithHooks(lifecycleContext(c), id, {
    actorUserId: actor.id,
    expectedRevision: body.expectedRevision,
    expectedGrantKey: body.grantKey,
  });
  return ok(c, { app: await detail(c, result.installation), hookError: result.hookError });
});

// ── Deactivate ──

const deactivateRoute = createRoute({
  method: "post",
  path: "/{id}/deactivate",
  operationId: "dashboard.apps.deactivate",
  tags: ["Admin - Apps"],
  summary: "Stop an app (its data and settings stay)",
  request: {
    params: idParams,
    body: { required: true, content: { "application/json": { schema: z.object({ expectedRevision: revisionSchema }) } } },
  },
  responses: {
    200: {
      description: "Stopped",
      content: { "application/json": { schema: successEnvelope(z.object({ app: appDetailSchema, hookError: z.string().nullable() })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(deactivateRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  const { deactivatePluginWithHooks } = await lifecycle();
  const result = await deactivatePluginWithHooks(lifecycleContext(c), id, { expectedRevision: c.req.valid("json").expectedRevision });
  return ok(c, { app: await detail(c, result.installation), hookError: result.hookError });
});

// ── Features ──

const featureParams = idParams.extend({
  featureId: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).openapi({ description: "The feature's id (manifest.features[].id)." }),
});
const featureResultSchema = successEnvelope(z.object({
  app: appDetailSchema,
  changed: z.boolean().openapi({ description: "False when the feature was already in that state." }),
  hookError: z.string().nullable(),
}));

const featuresListRoute = createRoute({
  method: "get",
  path: "/{id}/features",
  operationId: "dashboard.apps.features_list",
  tags: ["Admin - Apps"],
  summary: "List an app's features: which are on, and what each asks for",
  description: "Each feature starts off. Turning one on asks a Super Admin to approve that feature's own access (dashboard.apps.feature_enable); turning one off revokes it at once.",
  request: { params: idParams },
  responses: {
    200: {
      description: "Features",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ revision: z.number().int(), status: z.enum(["installed", "active", "disabled", "failed"]), features: z.array(appFeatureSchema) })),
        },
      },
    },
    ...readErrors,
  },
});

app.openapi(featuresListRoute, async (c) => {
  noStore(c);
  const installation = await loadApp(c, c.req.valid("param").id);
  return ok(c, { revision: installation.revision, status: installation.status, features: await featureRows(installation) });
});

const featureEnableRoute = createRoute({
  method: "post",
  path: "/{id}/features/{featureId}/enable",
  operationId: "dashboard.apps.feature_enable",
  tags: ["Admin - Apps"],
  summary: "Turn on one of an app's features and approve its access (Super Admin)",
  description: "The app must be on. Approves only this feature's scopes and hosts (grantKey: the feature's, as shown), records the approving Super Admin as the app's acting user, then runs the app's enable hook. Its providers, settings, routes and jobs start with the write.",
  request: {
    params: featureParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ expectedRevision: revisionSchema, grantKey: z.string().min(2).max(65_536) }) } },
    },
  },
  responses: {
    200: { description: "On", content: { "application/json": { schema: featureResultSchema } } },
    ...mutationErrors,
  },
});

app.openapi(featureEnableRoute, async (c) => {
  noStore(c);
  const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
  // Consent is a person's: a Super Admin in the dashboard, never an agent or a plugin.
  if (!actor?.id || actor.isSuperAdmin !== true || c.get("agentPrincipal") || c.get("pluginPrincipal")) {
    throw new ForbiddenError("Only a Super Admin can approve a feature's access.");
  }
  const { id, featureId } = c.req.valid("param");
  const body = c.req.valid("json");
  await loadApp(c, id);
  const { setPluginFeatureWithHooks } = await lifecycle();
  const result = await setPluginFeatureWithHooks(lifecycleContext(c), id, {
    feature: featureId,
    enabled: true,
    expectedRevision: body.expectedRevision,
    expectedGrantKey: body.grantKey,
    actorUserId: actor.id,
  });
  return ok(c, { app: await detail(c, result.installation), changed: result.changed, hookError: result.hookError });
});

const featureDisableRoute = createRoute({
  method: "post",
  path: "/{id}/features/{featureId}/disable",
  operationId: "dashboard.apps.feature_disable",
  tags: ["Admin - Apps"],
  summary: "Turn off one of an app's features (its access is revoked)",
  description: "Runs the app's disable hook while the feature is still on, then revokes the feature's scopes and hosts and stops its providers, routes and jobs. Its settings stay for when it is turned on again.",
  request: {
    params: featureParams,
    body: { required: true, content: { "application/json": { schema: z.object({ expectedRevision: revisionSchema }) } } },
  },
  responses: {
    200: { description: "Off", content: { "application/json": { schema: featureResultSchema } } },
    ...mutationErrors,
  },
});

app.openapi(featureDisableRoute, async (c) => {
  noStore(c);
  const { id, featureId } = c.req.valid("param");
  const body = c.req.valid("json");
  const { setPluginFeatureWithHooks } = await lifecycle();
  const result = await setPluginFeatureWithHooks(lifecycleContext(c), id, {
    feature: featureId,
    enabled: false,
    expectedRevision: body.expectedRevision,
  });
  return ok(c, { app: await detail(c, result.installation), changed: result.changed, hookError: result.hookError });
});

// ── Settings ──

const settingsRoute = createRoute({
  method: "put",
  path: "/{id}/settings",
  operationId: "dashboard.apps.settings_update",
  tags: ["Admin - Apps"],
  summary: "Save an app's settings",
  description: "The whole settings document, validated against the app's schema. A secret is write-only: send a new value to set it, null to clear it, or leave it out to keep it.",
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ expectedRevision: revisionSchema, values: z.record(z.string(), settingValueSchema) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: successEnvelope(z.object({ app: appDetailSchema })) } } },
    ...mutationErrors,
  },
});

app.openapi(settingsRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const installation = await writePluginSettings(c.get("db"), id, body.values, {
    expectedRevision: body.expectedRevision,
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  // Saving keys can make a waiting SMS provider ready; features adopt in the lifecycle.
  await putServicesToUse(lifecycleContext(c), installation, []);
  return ok(c, { app: await detail(c, installation) });
});

// ── Uninstall ──

const uninstallRoute = createRoute({
  method: "post",
  path: "/{id}/uninstall",
  operationId: "dashboard.apps.uninstall",
  tags: ["Admin - Apps"],
  summary: "Uninstall an app, keeping or deleting its data",
  description: "keepData true keeps everything the app owns, its settings included, and a reinstall takes it back; until then dashboard.apps.removed_data_list lists it. keepData false permanently deletes it: stored records, key/value data, custom fields (with their values), the roles it granted customers, its jobs, logs, delivery history, settings and files; catalogue items it created stay, and those in the trash are permanently deleted unless the store must keep them (inventory history, orders, a file still shown). Confirm that choice in plain words first. An app compiled into this deployment appears again as installed; remove it from the deployment with pnpm plugin remove.",
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ expectedRevision: revisionSchema, keepData: z.boolean() }) } },
    },
  },
  responses: {
    200: {
      description: "Uninstalled",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            id: z.string(),
            uninstalled: z.literal(true),
            keepData: z.boolean(),
            hookError: z.string().nullable(),
            catalogDeleted: z.number().int().openapi({ description: "Trashed catalogue items it created that were permanently deleted (keepData false)." }),
            catalogKept: z.number().int().openapi({ description: "Trashed ones the store must keep; they stay in the trash." }),
          })),
        },
      },
    },
    ...mutationErrors,
  },
});

app.openapi(uninstallRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const { uninstallPluginWithHooks } = await lifecycle();
  const result = await uninstallPluginWithHooks(lifecycleContext(c), id, body);
  return ok(c, {
    id,
    uninstalled: true as const,
    keepData: body.keepData,
    hookError: result.hookError,
    catalogDeleted: result.catalogDeleted,
    catalogKept: result.catalogKept,
  });
});

// ── Logs ──

const logsRoute = createRoute({
  method: "get",
  path: "/{id}/logs",
  operationId: "dashboard.apps.logs_list",
  tags: ["Admin - Apps"],
  summary: "An app's newest log lines (masked), newest first",
  request: {
    params: idParams,
    query: z.object({
      before: z.string().min(1).max(64).optional().openapi({ description: "`nextCursor` of the previous page." }),
      limit: z.coerce.number().int().min(1).max(APP_LOG_PAGE_MAX).default(50),
    }),
  },
  responses: {
    200: {
      description: "Log lines",
      content: { "application/json": { schema: successEnvelope(z.object({ lines: z.array(appLogLineSchema), nextCursor: z.string().nullable() })) } },
    },
    400: errorResponses[400],
    ...readErrors,
  },
});

app.openapi(logsRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  const query = c.req.valid("query");
  await requirePluginInstallation(c.get("db"), id);
  const lines = await listPluginLogs(c.get("db"), id, { limit: query.limit, before: query.before ?? null });
  return ok(c, {
    lines: lines.map((line) => ({ ...line, createdAt: iso(line.createdAt) })),
    nextCursor: lines.length === query.limit ? lines[lines.length - 1]!.id : null,
  });
});

// ── Deliveries ──

const deliveriesRoute = createRoute({
  method: "get",
  path: "/{id}/deliveries",
  operationId: "dashboard.apps.deliveries_list",
  tags: ["Admin - Apps"],
  summary: "List an app's deliveries, newest first",
  request: {
    params: idParams,
    query: z.object({
      status: z.enum(PLUGIN_EVENT_DELIVERY_STATUSES).optional(),
      cursor: z.string().min(1).max(64).optional().openapi({ description: "`nextCursor` of the previous page." }),
      limit: z.coerce.number().int().min(1).max(PLUGIN_DELIVERY_LIST_MAX_LIMIT).default(25),
    }),
  },
  responses: {
    200: {
      description: "Deliveries",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ deliveries: z.array(appDeliverySchema), nextCursor: z.string().nullable() })),
        },
      },
    },
    400: errorResponses[400],
    ...readErrors,
  },
});

app.openapi(deliveriesRoute, async (c) => {
  noStore(c);
  const { id } = c.req.valid("param");
  await requirePluginInstallation(c.get("db"), id);
  const page = await listPluginEventDeliveries(c.get("db"), id, c.req.valid("query"));
  return ok(c, { deliveries: page.deliveries.map(deliveryResponse), nextCursor: page.nextCursor });
});

const retryRoute = createRoute({
  method: "post",
  path: "/{id}/deliveries/{deliveryId}/retry",
  operationId: "dashboard.apps.delivery_retry",
  tags: ["Admin - Apps"],
  summary: "Send a failed, exhausted or cancelled delivery to the app again",
  request: {
    params: idParams.extend({ deliveryId: z.string().min(1).max(64) }),
  },
  responses: {
    200: {
      description: "The delivery, queued for a fresh retry cycle",
      content: { "application/json": { schema: successEnvelope(z.object({ delivery: appDeliverySchema })) } },
    },
    ...mutationErrors,
  },
});

app.openapi(retryRoute, async (c) => {
  noStore(c);
  const { id, deliveryId } = c.req.valid("param");
  const db = c.get("db");
  const delivery = await retryPluginEventDelivery(db, id, deliveryId);
  await afterResponse(c, "app delivery retry", async () => {
    const { sendEventDeliveries } = await import("../../events/dispatch");
    await sendEventDeliveries(db, c.env, executionContextOf(c), [{ type: "plugins.deliver", deliveryId }]);
  });
  return ok(c, { delivery: deliveryResponse(delivery) });
});

export { app as adminAppRoutes };
