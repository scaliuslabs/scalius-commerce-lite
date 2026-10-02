// Admin OpenAPI routes for installed apps (plugins, docs/platform/PLUGINS.md):
// the list (bundled plugins appear as installed automatically), one app's
// detail with its consent request in structured form, activation (Super Admin
// approves the grant), settings (secrets write-only), deactivation,
// uninstall (keep or delete data), the plugin log and event deliveries.
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
  PLUGIN_ID_PATTERN,
  PLUGIN_FUNCTION_POINTS,
  PLUGIN_NAV_PLACEMENTS,
  pluginGrantAdditions,
  pluginGrantKey,
  pluginGrantRequest,
  type PluginGrantRequest,
} from "@scalius/shared/plugins";
import { appSettingField, appSettingFieldSchema, appSettingValueSchema } from "../../schemas/app-settings";
import { ConflictError, ForbiddenError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { eventsQueue } from "../../events/flush";
import { BUNDLED_PLUGINS } from "../../plugins/bundled.gen";
import { syncBundledPlugin, syncBundledPlugins } from "../../plugins/bundled-sync";

import { isPluginSandboxAvailable } from "../../plugins/loaders/sandbox-availability";

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
  providers: z.array(z.string()),
  publicRoutes: z.boolean(),
  storefrontScripts: z.array(z.string()),
  storefrontSurfaces: z.boolean(),
  customFieldOwners: z.array(z.string()),
}).openapi("AppGrant", { description: "What an app may do; the consent screen lists it in plain words." });

const appSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.object({ name: z.string(), url: z.string().nullable() }),
  homepage: z.string().nullable(),
  source: z.enum(["bundled", "registry", "upload"]),
  status: z.enum(["installed", "active", "disabled", "failed"]),
  needsApproval: z.boolean().openapi({ description: "An update asks for more access than was approved; the app waits until a Super Admin approves it." }),
  failureReason: z.string().nullable(),
  revision: z.number().int(),
  installedAt: z.string(),
  activatedAt: z.string().nullable(),
  updatedAt: z.string(),
  functions: z.array(z.object({
    point: z.enum(PLUGIN_FUNCTION_POINTS),
    priority: z.number().int().openapi({ description: "Lower runs first among apps at the same point." }),
  })).openapi({ description: "The checkout function points the app implements (cart rules, discounts, delivery options, payment methods, order risk)." }),
}).openapi("AppSummary");

const settingValueSchema = appSettingValueSchema;
const settingFieldSchema = appSettingFieldSchema;

const routeSchema = z.object({ name: z.string(), methods: z.array(z.string()) });

const appDetailSchema = appSummarySchema.extend({
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
  }),
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
    sections: z.number().int(),
    productBlocks: z.number().int(),
    scripts: z.array(z.object({ src: z.string(), placement: z.string(), pages: z.array(z.string()) })),
  }),
  admin: z.object({
    pages: z.array(z.object({ id: z.string(), title: z.string(), placement: z.string(), route: z.string() })),
    cards: z.number().int(),
    actions: z.number().int(),
    widgets: z.number().int(),
  }),
  limits: z.object({ cpuMs: z.number().int(), wallMs: z.number().int() }),
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
    author: { name: manifest.author.name, url: manifest.author.url ?? null },
    homepage: manifest.homepage ?? null,
    source: installation.source,
    status: installation.status,
    needsApproval: pluginNeedsApproval(installation),
    failureReason: installation.failureReason,
    revision: installation.revision,
    installedAt: iso(installation.installedAt),
    activatedAt: isoOrNull(installation.activatedAt),
    updatedAt: iso(installation.updatedAt),
    functions: manifest.functions.map((fn) => ({ point: fn.point, priority: fn.priority })),
  };
}

const settingField = appSettingField;

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
  const [approver, lastRuns, permissions] = await Promise.all([
    installation.activatedBy
      ? db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.id, installation.activatedBy)).get()
      : Promise.resolve(undefined),
    latestPluginCronRuns(db, installation.pluginId, manifest.cron.map((job) => job.name)),
    permissionRows(request),
  ]);
  const available = runtimeAvailable(c, installation);
  return {
    ...summary(installation),
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
    },
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
      sections: manifest.storefront.sections.length,
      productBlocks: manifest.storefront.productBlocks.length,
      scripts: manifest.storefront.scripts.map((script) => ({ src: script.src, placement: script.placement, pages: [...script.pages] })),
    },
    admin: {
      pages: manifest.admin.pages.map((page) => ({ id: page.id, title: page.title, placement: page.placement, route: page.route })),
      cards: manifest.admin.cards.length,
      actions: manifest.admin.actions.length,
      widgets: manifest.admin.widgets.length,
    },
    limits: { cpuMs: manifest.limits.cpuMs, wallMs: manifest.limits.wallMs },
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
          schema: successEnvelope(z.object({ apps: z.array(appSummarySchema), sandboxAvailable: z.boolean() })),
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
  return ok(c, { apps: installations.map(summary), sandboxAvailable: sandboxAvailable(c) });
});

// ── Dashboard surfaces of active apps ──

const surfaceRouteSchema = z.object({
  name: z.string(),
  methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
});

const appAdminSurfacesSchema = z.object({
  id: z.string(),
  name: z.string(),
  pages: z.array(z.object({ id: z.string(), title: z.string(), placement: z.enum(PLUGIN_NAV_PLACEMENTS), route: z.string() })),
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
}).openapi("AppAdminSurfaces");

const surfacesRoute = createRoute({
  method: "get",
  path: "/surfaces",
  operationId: "dashboard.apps.surfaces",
  tags: ["Admin - Apps"],
  summary: "List what active apps add to the dashboard",
  description: "Pages (navigation entries), resource cards, actions and home widgets of every active app, from their manifests. Their content comes from each app's own admin routes.",
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
      const { admin, routes, name } = installation.manifest;
      return {
        id: installation.pluginId,
        name,
        pages: admin.pages.map((page) => ({ id: page.id, title: page.title, placement: page.placement, route: page.route })),
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
      };
    })
    .filter((surfaces) => surfaces.pages.length + surfaces.cards.length + surfaces.actions.length + surfaces.widgets.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return ok(c, { apps });
});

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
