// Admin OpenAPI routes for installed apps (plugins, docs/platform/PLUGINS.md):
// the list (bundled plugins appear as installed automatically), one app's
// detail with its consent request in structured form, activation (Super Admin
// approves the grant), settings (secrets write-only), deactivation,
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
  isOfficialPluginKey,
  isThirdPartyPlugin,
  pluginRegistrySettingsDocument,
  trustedPluginKeys,
  latestPluginCronRuns,
  listPluginEventDeliveries,
  listPluginInstallations,
  listPluginLogs,
  pluginNeedsApproval,
  requirePluginInstallation,
  retryPluginEventDelivery,
  writePluginSettings,
  type PluginEventDeliveryView,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { PERMISSION_METADATA } from "@scalius/core/auth/rbac/permission-metadata";
import {
  PLUGIN_ADMIN_TARGETS,
  PLUGIN_CATEGORIES,
  PLUGIN_ID_PATTERN,
  PLUGIN_FUNCTION_POINTS,
  PLUGIN_NAV_PLACEMENTS,
  pluginGrantAdditions,
  pluginGrantKey,
  pluginGrantRequest,
  appSettingsSections,
  providerOwnSettingKeys,
  providerSettingKeys,
  type PluginGrantRequest,
  type PluginManifest,
} from "@scalius/shared/plugins";
import { PROVIDER_KINDS, qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { appSettingField, appSettingFieldSchema, appSettingValueSchema } from "../../schemas/app-settings";
import { ConflictError, ForbiddenError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { eventsQueue } from "../../events/flush";
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

import { isPluginSandboxAvailable } from "../../plugins/loaders/sandbox-availability";
import { planLimits } from "@scalius/shared/plan-limits";
import { registerAppLifecycleRoutes } from "./apps-lifecycle";

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

const grantSchema = z.object({
  permissions: z.array(z.string()),
  allowedHosts: z.array(z.string()),
  events: z.array(z.string()),
  functions: z.array(z.string()),
  blockingFunctions: z.array(z.string()).openapi({ description: "Function points where the app may pause checkout when it cannot answer." }),
  providers: z.array(z.string()),
  publicRoutes: z.boolean(),
  storefrontScripts: z.array(z.string()),
  storefrontSurfaces: z.boolean(),
  customFieldOwners: z.array(z.string()),
}).openapi("AppGrant", { description: "What an app may do; the consent screen lists it in plain words." });

/** The manifest's text in other dashboard languages; the dashboard picks its own. */
const appTranslationsSchema = z.object({
  bn: z.object({
    name: z.string().optional(),
    tagline: z.string().optional(),
    description: z.string().optional(),
    pages: z.record(z.string(), z.string()).optional(),
    cards: z.record(z.string(), z.string()).optional(),
    actions: z.record(z.string(), z.string()).optional(),
    widgets: z.record(z.string(), z.string()).optional(),
    tabs: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    settingsGroups: z.record(z.string(), z.object({ title: z.string().optional(), description: z.string().optional() })).optional(),
    settings: z.record(z.string(), z.object({ label: z.string().optional(), help: z.string().optional() })).optional(),
  }).optional(),
}).nullable().openapi("AppTranslations", { description: "Name, tagline, description and surface titles in other dashboard languages (null: English only)." });

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
  functions: z.array(z.object({
    point: z.enum(PLUGIN_FUNCTION_POINTS),
    priority: z.number().int().openapi({ description: "Lower runs first among apps at the same point." }),
    onError: z.enum(["skip", "block"]).openapi({ description: "block: the app pauses checkout when it cannot answer (needs approval)." }),
    snapshotCollection: z.string().nullable().openapi({ description: "checkout.discounts: the app reads and updates the signed-in buyer's record in this collection with each order." }),
  })).openapi({ description: "The checkout function points the app implements (cart rules, discounts, delivery options, payment methods, order risk)." }),
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

const appDetailSchema = appSummarySchema.extend({
  ...listingDetailFields,
  grantKey: z.string().openapi({ description: "Send back on activation: approving a request nobody was shown is refused." }),
  request: grantSchema,
  granted: grantSchema.nullable(),
  added: grantSchema.openapi({ description: "What the request adds to the approved grant (everything before the first approval)." }),
  permissions: z.array(z.object({
    name: z.string(),
    risk: z.enum(["read", "write", "destructive", "financial"]),
    sensitive: z.boolean(),
  })),
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
  })).openapi({ description: "The providers the app offers, each set up on its capability's settings page." }),
  routes: z.object({ admin: z.array(routeSchema), public: z.array(routeSchema), webhooks: z.array(z.string()) }),
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
  storage: z.array(z.string()),
  customFields: z.array(z.object({ ownerType: z.string(), key: z.string(), name: z.string(), type: z.string() })),
  storefront: z.object({
    proxy: z.boolean(),
    head: z.boolean(),
    sections: z.array(z.object({ type: z.string(), name: z.string() })),
    productBlocks: z.array(z.object({ type: z.string(), name: z.string(), placement: z.enum(["buy-box", "below"]) })),
    scripts: z.array(z.object({ src: z.string(), placement: z.string(), pages: z.array(z.string()) })),
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
    thirdParty: isThirdPartyPlugin(installation.pluginId),
    signed: installation.signerKeyId !== null,
    failureReason: installation.failureReason,
    revision: installation.revision,
    installedAt: iso(installation.installedAt),
    activatedAt: isoOrNull(installation.activatedAt),
    updatedAt: iso(installation.updatedAt),
    functions: manifest.functions.map((fn) => ({
      point: fn.point,
      priority: fn.priority,
      onError: fn.onError,
      snapshotCollection: fn.snapshot?.collection ?? null,
    })),
  };
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
    icon: providerIconUrl(installation.pluginId, installation.manifest, provider.id, installation.bundleSha256),
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

/** Each requested permission with the highest risk among the operations it lets the app call. */
async function permissionRows(request: PluginGrantRequest) {
  const { derivePluginRiskCeiling } = await import("../../plugins/authority");
  return request.permissions.map((name) => {
    const metadata = Object.prototype.hasOwnProperty.call(PERMISSION_METADATA, name)
      ? (PERMISSION_METADATA as Record<string, { isSensitive: boolean }>)[name]
      : undefined;
    const risk = derivePluginRiskCeiling(new Set([name]));
    return {
      name,
      risk: (risk === "security" ? "financial" : risk) as "read" | "write" | "destructive" | "financial",
      sensitive: metadata?.isSensitive ?? false,
    };
  });
}

function runtimeAvailable(c: Context<{ Bindings: Env }>, installation: PluginInstallation): boolean {
  if (installation.source === "bundled") return Object.prototype.hasOwnProperty.call(BUNDLED_PLUGINS, installation.pluginId);
  return sandboxAvailable(c);
}

async function detail(c: Context<{ Bindings: Env }>, installation: PluginInstallation) {
  const db = c.get("db");
  const { manifest } = installation;
  const request = pluginGrantRequest(manifest);
  const described = describePluginSettings(installation);
  const caps = planLimits().plugins;
  const [approver, lastRuns, permissions, registrySettings] = await Promise.all([
    installation.activatedBy
      ? db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.id, installation.activatedBy)).get()
      : Promise.resolve(undefined),
    latestPluginCronRuns(db, installation.pluginId, manifest.cron.map((job) => job.name)),
    permissionRows(request),
    installation.signerKeyId ? pluginRegistrySettingsDocument.read(db) : Promise.resolve({ registries: [], trustedKeys: [] }),
  ]);
  const available = runtimeAvailable(c, installation);
  return {
    ...summary(installation),
    ...listingDetail(installation.pluginId, manifest, installation.bundleSha256),
    grantKey: pluginGrantKey(request),
    request,
    granted: installation.grant,
    added: pluginGrantAdditions(installation.grant, request),
    permissions,
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
    })),
    routes: {
      admin: manifest.routes.admin.map((route) => ({ name: route.name, methods: [...route.methods] })),
      public: manifest.routes.public.map((route) => ({ name: route.name, methods: [...route.methods] })),
      webhooks: [...manifest.routes.webhooks],
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
    storage: Object.keys(manifest.storage),
    customFields: manifest.customFields.map((field) => ({ ownerType: field.ownerType, key: field.key, name: field.name, type: field.type })),
    storefront: {
      proxy: manifest.storefront.proxy,
      head: manifest.storefront.head,
      sections: manifest.storefront.sections.map((section) => ({ type: section.type, name: section.name })),
      productBlocks: manifest.storefront.productBlocks.map((block) => ({ type: block.type, name: block.name, placement: block.placement })),
      scripts: manifest.storefront.scripts.map((script) => ({ src: script.src, placement: script.placement, pages: [...script.pages] })),
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
  const installations = await listPluginInstallations(db);
  const installed = new Set(installations.map((installation) => installation.pluginId));
  const available = PLUGIN_CATALOG.filter((entry) => !installed.has(entry.id)).map(catalogListing);
  return ok(c, { apps: installations.map(summary), available, sandboxAvailable: sandboxAvailable(c) });
});

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
  const missing = () => new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Image not found" } }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
  const installation = await requirePluginInstallation(c.get("db"), id).catch(() => null);
  let response: Response | null = null;
  if (installation) {
    const target = pluginAssetPath(installation.manifest, asset);
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
        routes: routes.admin.map((route) => ({ name: route.name, methods: [...route.methods] })),
        providers: installation.manifest.providers.map((provider) => providerEntry(installation, provider)),
        translations: translations ?? null,
      };
    })
    .filter((surfaces) => surfaces.pages.length + surfaces.cards.length + surfaces.actions.length + surfaces.widgets.length + surfaces.providers.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return ok(c, { apps });
});

// ── Registry, upload, update and emergency stop (apps-lifecycle.ts; before `/{id}`) ──

registerAppLifecycleRoutes(app, { detail, detailSchema: appDetailSchema, lifecycleContext: lifecycleContext as never });

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
  return ok(c, { app: await detail(c, installation) });
});

// ── Uninstall ──

const uninstallRoute = createRoute({
  method: "post",
  path: "/{id}/uninstall",
  operationId: "dashboard.apps.uninstall",
  tags: ["Admin - Apps"],
  summary: "Uninstall an app, keeping or deleting its data",
  description: "keepData false deletes the app's stored records, key/value data, logs, delivery and job history and its custom fields (with their values). An app compiled into this deployment appears again as installed; remove it from the deployment with pnpm plugin remove.",
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
          schema: successEnvelope(z.object({ id: z.string(), uninstalled: z.literal(true), keepData: z.boolean(), hookError: z.string().nullable() })),
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
  return ok(c, { id, uninstalled: true as const, keepData: body.keepData, hookError: result.hookError });
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
  const delivery = await retryPluginEventDelivery(c.get("db"), id, deliveryId, eventsQueue(c.env));
  return ok(c, { delivery: deliveryResponse(delivery) });
});

export { app as adminAppRoutes };
