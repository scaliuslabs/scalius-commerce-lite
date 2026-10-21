// Admin routes for the app lifecycle beyond the installed list
// (docs/platform/PLUGINS.md, "Registry", "Quotas and kill switch"): browse the
// configured registries, install or update from one (Workers Paid), upload a
// package (Workers Paid), the emergency stop of one app or of every
// third-party app, and the registries and developer keys the store trusts.
// Registered by apps.ts before its `/{id}` routes. RBAC: apps.view reads,
// apps.manage installs, updates and stops; trusting a developer, accepting an
// unsigned package and changing the trusted keys are a Super Admin's, in the
// dashboard (never an agent's or an app's).

import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  PluginError,
  getPluginInstallation,
  listPluginInstallations,
  pluginRegistrySettingsDocument,
  pluginRegistrySources,
  requirePinnedSigner,
  requirePluginInstallation,
  stopPlugin,
  stopThirdPartyPlugins,
  trustedPluginKeys,
  isOfficialPluginKey,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { OFFICIAL_PLUGIN_REGISTRY, trustedKeyFrom } from "@scalius/shared/plugins/registry";
import { pluginCompatibility, PLUGIN_ID_PATTERN } from "@scalius/shared/plugins";
import { ForbiddenError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { conflictResponse, errorResponseSchema, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { isPluginSandboxAvailable } from "../../plugins/loaders/sandbox-availability";
import { PLUGIN_PACKAGE_MAX_BYTES } from "../../plugins/package-zip";

type AppContext = Context<{ Bindings: Env }>;

/** What apps.ts lends this file: its detail presenter, schema and lifecycle context. */
export interface AppLifecycleRouteDeps {
  detail(c: AppContext, installation: PluginInstallation): Promise<unknown>;
  detailSchema: z.ZodTypeAny;
  lifecycleContext(c: AppContext): { db: ReturnType<AppContext["get"]>; env: Env; ctx: ExecutionContext };
}

const lifecycle = () => import("../../plugins/lifecycle");
const releases = () => import("../../plugins/releases");

const idParams = z.object({ id: z.string().regex(PLUGIN_ID_PATTERN).openapi({ description: "The app's id (vendor.name)." }) });
const registryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).openapi({ description: "The registry's id (`official` for the official registry)." });
const versionSchema = z.string().min(5).max(80).optional().openapi({ description: "A listed version; left out, the newest one." });

/** A release whose hash, signature or package does not check out. */
const unverifiable = { description: "The release failed verification", content: { "application/json": { schema: errorResponseSchema } } } as const;
const registryUnavailable = { description: "The registry could not be read", content: { "application/json": { schema: errorResponseSchema } } } as const;

const mutationErrors = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  503: serviceUnavailableResponse,
} as const;

function noStore(c: { header(name: string, value: string): void }) {
  c.header("Cache-Control", "private, no-store");
}

function sandboxAvailable(c: AppContext): boolean {
  try {
    return isPluginSandboxAvailable(c.env, c.executionCtx as unknown as ExecutionContext);
  } catch {
    return false;
  }
}

function requireSandbox(c: AppContext): void {
  if (!sandboxAvailable(c)) {
    throw new PluginError("installation_sandbox_required", "Installing from the dashboard needs Workers Paid with the plugin sandbox. On Workers Free, run the command shown and deploy.");
  }
}

/** A person in the dashboard with Super Admin rights (never an agent or an app). */
function isSuperAdminPerson(c: AppContext): boolean {
  const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
  return Boolean(actor?.id) && actor?.isSuperAdmin === true && !c.get("agentPrincipal") && !c.get("pluginPrincipal");
}

function actorId(c: AppContext): string | null {
  return (c.get("user") as { id?: string } | undefined)?.id ?? null;
}

const signerSchema = z.object({
  keyId: z.string(),
  name: z.string().nullable().openapi({ description: "The trusted key's name; null when this store does not trust the key." }),
  trusted: z.boolean(),
  official: z.boolean(),
}).openapi("AppSigner");

const registryAppSchema = z.object({
  registryId: z.string(),
  id: z.string(),
  name: z.string(),
  version: z.string(),
  tagline: z.string().nullable(),
  description: z.string(),
  author: z.string(),
  signer: signerSchema,
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable().openapi({ description: "Why this Scalius cannot run it (plugin API version or platform release)." }),
  installed: z.object({ version: z.string(), source: z.enum(["bundled", "registry", "upload"]) }).nullable(),
  updateAvailable: z.boolean().openapi({ description: "Newer than the installed version (a bundled app updates with a deploy)." }),
  installCommand: z.string().openapi({ description: "The operator's command on Workers Free (bundles the app; then deploy)." }),
}).openapi("RegistryApp");

const registryStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  official: z.boolean(),
  status: z.enum(["ok", "unavailable"]),
  error: z.string().nullable(),
}).openapi("RegistryState");

export function registerAppLifecycleRoutes(app: OpenAPIHono<{ Bindings: Env }>, deps: AppLifecycleRouteDeps): void {
  const detailEnvelope = (extra: Record<string, z.ZodTypeAny> = {}) => successEnvelope(z.object({ app: deps.detailSchema, ...extra }));

  // ── Browse ──
  app.openapi(createRoute({
    method: "get",
    path: "/registry",
    operationId: "dashboard.apps.registry_list",
    tags: ["Admin - Apps"],
    summary: "Browse the app registries this store uses",
    description: "Reads each configured registry's signed index on the server. Signatures are verified when an app is installed; a listing only says whether its key is trusted. On Workers Free each app shows its install command.",
    responses: {
      200: {
        description: "Registry apps",
        content: {
          "application/json": {
            schema: successEnvelope(z.object({
              officialConfigured: z.boolean().openapi({ description: "False until the official registry and its key are published." }),
              installMode: z.enum(["dashboard", "command"]).openapi({ description: "dashboard: one-click install (Workers Paid); command: run installCommand, then deploy." }),
              registries: z.array(registryStateSchema),
              apps: z.array(registryAppSchema),
            })),
          },
        },
      },
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }), async (c) => {
    noStore(c);
    const db = c.get("db");
    const { fetchRegistryIndex, readRegistrySettings, hasUpdate } = await releases();
    const settings = await readRegistrySettings(db);
    const trusted = trustedPluginKeys(settings);
    const installed = new Map((await listPluginInstallations(db)).map((installation) => [installation.pluginId, installation]));
    const sources = pluginRegistrySources(settings);
    const results = await Promise.all(sources.map(async (source) => {
      try {
        return { source, index: await fetchRegistryIndex(source.indexUrl), error: null };
      } catch (error) {
        return { source, index: null, error: error instanceof Error ? error.message : "The registry could not be read." };
      }
    }));
    const apps: Array<z.infer<typeof registryAppSchema>> = [];
    for (const { source, index } of results) {
      if (!index) continue;
      // The newest listed version of each app.
      const newest = new Map<string, (typeof index.apps)[number]>();
      const { isNewerPluginVersion } = await import("@scalius/shared/plugins/registry");
      for (const entry of index.apps) {
        const best = newest.get(entry.id);
        if (!best || isNewerPluginVersion(entry.version, best.version)) newest.set(entry.id, entry);
      }
      for (const entry of newest.values()) {
        const manifest = entry.manifest as { name?: unknown; tagline?: unknown; description?: unknown; author?: { name?: unknown } };
        const key = trusted.find((candidate) => candidate.id === entry.signature.keyId) ?? null;
        const compatible = pluginCompatibility(entry.manifest);
        const current = installed.get(entry.id) ?? null;
        apps.push({
          registryId: source.id,
          id: entry.id,
          name: typeof manifest.name === "string" ? manifest.name : entry.id,
          version: entry.version,
          tagline: typeof manifest.tagline === "string" ? manifest.tagline : null,
          description: typeof manifest.description === "string" ? manifest.description : "",
          author: typeof manifest.author?.name === "string" ? manifest.author.name : "",
          signer: { keyId: entry.signature.keyId, name: key?.name ?? null, trusted: key !== null, official: isOfficialPluginKey(entry.signature.keyId) },
          compatible: compatible.ok,
          incompatibleReason: compatible.ok ? null : compatible.message,
          installed: current ? { version: current.version, source: current.source } : null,
          updateAvailable: current ? hasUpdate(current, entry) : false,
          installCommand: `pnpm plugin add ${entry.id} --registry ${source.indexUrl}`,
        });
      }
    }
    apps.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return ok(c, {
      officialConfigured: OFFICIAL_PLUGIN_REGISTRY.indexUrl !== null && OFFICIAL_PLUGIN_REGISTRY.keys.length > 0,
      installMode: sandboxAvailable(c) ? "dashboard" as const : "command" as const,
      registries: results.map(({ source, error }) => ({
        id: source.id,
        name: source.name,
        official: source.official,
        status: error ? "unavailable" as const : "ok" as const,
        error,
      })),
      apps,
    });
  });

  // ── Registry settings ──
  const trustedKeyView = z.object({
    id: z.string(),
    name: z.string(),
    publicKey: z.string(),
    official: z.boolean(),
  }).openapi("TrustedAppKey");
  const registrySettingsView = z.object({
    revision: z.number().int(),
    officialConfigured: z.boolean(),
    registries: z.array(z.object({ id: z.string(), name: z.string(), indexUrl: z.string() })),
    trustedKeys: z.array(trustedKeyView),
  }).openapi("AppRegistrySettings");

  async function registrySettingsResponse(c: AppContext) {
    const read = await pluginRegistrySettingsDocument.readDetailed(c.get("db"));
    return {
      revision: read.revision,
      officialConfigured: OFFICIAL_PLUGIN_REGISTRY.indexUrl !== null && OFFICIAL_PLUGIN_REGISTRY.keys.length > 0,
      registries: read.value.registries.map((registry) => ({ ...registry })),
      trustedKeys: trustedPluginKeys(read.value).map((key) => ({ ...key, official: isOfficialPluginKey(key.id) })),
    };
  }

  app.openapi(createRoute({
    method: "get",
    path: "/registry/settings",
    operationId: "dashboard.apps.registry_settings_get",
    tags: ["Admin - Apps"],
    summary: "The registries this store browses and the developer keys it trusts",
    responses: {
      200: { description: "Registry settings", content: { "application/json": { schema: successEnvelope(registrySettingsView) } } },
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }), async (c) => {
    noStore(c);
    return ok(c, await registrySettingsResponse(c));
  });

  app.openapi(createRoute({
    method: "put",
    path: "/registry/settings",
    operationId: "dashboard.apps.registry_settings_update",
    tags: ["Admin - Apps"],
    summary: "Change the registries and trusted developer keys (Super Admin)",
    description: "The whole list of the store's own registries and trusted keys. A key is the developer's base64 Ed25519 public key; its id is derived. The official registry and key are pinned in code and cannot be changed here.",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              expectedRevision: z.number().int().min(0),
              registries: z.array(z.object({ id: registryIdSchema, name: z.string().trim().min(1).max(80), indexUrl: z.string().url().max(500) })).max(10),
              trustedKeys: z.array(z.object({ name: z.string().trim().min(1).max(80), publicKey: z.string().min(40).max(64) })).max(50),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: successEnvelope(registrySettingsView) } } },
      ...mutationErrors,
    },
  }), async (c) => {
    noStore(c);
    if (!isSuperAdminPerson(c)) throw new ForbiddenError("Only a Super Admin can change which developers this store trusts.");
    const body = c.req.valid("json");
    const keys = [];
    for (const entry of body.trustedKeys) {
      const key = await trustedKeyFrom(entry.publicKey.trim(), entry.name);
      if (!key) throw new ValidationError(`${entry.name}: the public key is not a base64 Ed25519 key.`);
      if (!isOfficialPluginKey(key.id)) keys.push(key);
    }
    await pluginRegistrySettingsDocument.write(
      c.get("db"),
      { registries: body.registries, trustedKeys: keys },
      undefined,
      { expectedRevision: body.expectedRevision, replace: true },
    );
    return ok(c, await registrySettingsResponse(c));
  });

  // ── Install from a registry ──
  app.openapi(createRoute({
    method: "post",
    path: "/registry/install",
    operationId: "dashboard.apps.registry_install",
    tags: ["Admin - Apps"],
    summary: "Install an app from a registry (Workers Paid)",
    description: "Downloads the release, verifies its SHA-256, its compatibility and its signature against the trusted keys, stores it, and installs it. Nothing runs until a Super Admin approves its access (dashboard.apps.activate).",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: z.object({ registryId: registryIdSchema, id: z.string().regex(PLUGIN_ID_PATTERN), version: versionSchema }) } },
      },
    },
    responses: {
      200: { description: "Installed, waiting for approval", content: { "application/json": { schema: detailEnvelope() } } },
      ...mutationErrors,
      422: unverifiable,
      502: registryUnavailable,
    },
  }), async (c) => {
    noStore(c);
    requireSandbox(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    if (await getPluginInstallation(db, body.id)) {
      throw new PluginError("installation_exists", `${body.id} is already installed; update it from its page.`);
    }
    const { downloadRegistryRelease, storeRelease, installRelease } = await releases();
    const release = await downloadRegistryRelease(db, body);
    await storeRelease(c.env, release);
    const installation = await installRelease(db, release, { source: "registry", actorUserId: actorId(c) });
    return ok(c, { app: await deps.detail(c, installation) });
  });

  // ── Update ──
  app.openapi(createRoute({
    method: "post",
    path: "/{id}/update",
    operationId: "dashboard.apps.update",
    tags: ["Admin - Apps"],
    summary: "Update an app from its registry (Workers Paid)",
    description: "Verifies and stores the new release, then replaces the code. An update that asks for more access waits for a Super Admin's approval. An active app loads the new code and runs its data updates at once; when either fails, the previous version comes back (rolledBack) and the reason is reported.",
    request: {
      params: idParams,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ expectedRevision: z.number().int().min(1), registryId: registryIdSchema, version: versionSchema }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated, waiting for approval, or rolled back",
        content: { "application/json": { schema: detailEnvelope({ rolledBack: z.boolean(), error: z.string().nullable() }) } },
      },
      ...mutationErrors,
      422: unverifiable,
      502: registryUnavailable,
    },
  }), async (c) => {
    noStore(c);
    requireSandbox(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const current = await requirePluginInstallation(db, id);
    if (current.source === "bundled") {
      throw new PluginError("installation_source_conflict", `${current.manifest.name} is compiled into this deployment: update it with pnpm plugin add, then deploy.`);
    }
    const { downloadRegistryRelease, storeRelease } = await releases();
    const release = await downloadRegistryRelease(db, { registryId: body.registryId, id, ...(body.version ? { version: body.version } : {}) });
    if (release.sha256 === current.bundleSha256) {
      return ok(c, { app: await deps.detail(c, current), rolledBack: false, error: null });
    }
    // Before anything is stored: an update keeps the developer the app was installed with.
    requirePinnedSigner(current, { source: "registry", signerKeyId: release.signer?.id ?? null });
    await storeRelease(c.env, release);
    const { updatePluginToRelease } = await lifecycle();
    const result = await updatePluginToRelease(
      deps.lifecycleContext(c) as never,
      current,
      { manifest: release.manifest, sha256: release.sha256, signerKeyId: release.signer?.id ?? null, source: "registry" },
      { expectedRevision: body.expectedRevision },
    );
    return ok(c, { app: await deps.detail(c, result.installation), rolledBack: result.rolledBack, error: result.error });
  });

  // ── Upload ──
  app.openapi(createRoute({
    method: "post",
    path: "/upload",
    operationId: "dashboard.apps.upload",
    tags: ["Admin - Apps"],
    summary: "Install or update an app from a package file (Workers Paid)",
    description: "A ZIP of what `pnpm plugin pack` writes (manifest.json, plugin.js, assets/, signature.json when signed). It goes through the registry's checks. An unsigned package (allowUnsigned) or one signed by a developer the store does not trust yet (trustDeveloper) needs a Super Admin's explicit choice.",
    request: {
      query: z.object({
        allowUnsigned: z.enum(["true", "false"]).optional().openapi({ description: "true: a Super Admin accepts a package without a signature." }),
        trustDeveloper: z.enum(["true", "false"]).optional().openapi({ description: "true: a Super Admin trusts the package's developer key from now on." }),
      }),
      body: {
        required: true,
        content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
      },
    },
    responses: {
      200: {
        description: "Installed (waiting for approval), updated, or rolled back",
        content: {
          "application/json": {
            schema: detailEnvelope({ updated: z.boolean(), rolledBack: z.boolean(), error: z.string().nullable() }),
          },
        },
      },
      ...mutationErrors,
      422: unverifiable,
    },
  }), async (c) => {
    noStore(c);
    requireSandbox(c);
    const query = c.req.valid("query");
    const trust = { allowUnsigned: query.allowUnsigned === "true", trustDeveloper: query.trustDeveloper === "true" };
    if ((trust.allowUnsigned || trust.trustDeveloper) && !isSuperAdminPerson(c)) {
      throw new ForbiddenError("Only a Super Admin can install an unsigned app or trust a new developer.");
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > PLUGIN_PACKAGE_MAX_BYTES) throw new PluginError("package_invalid", "The package is larger than 20 MiB.");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) throw new PluginError("package_invalid", "The package is empty.");
    const db = c.get("db");
    const { readPluginPackageZip } = await import("../../plugins/package-zip");
    const { verifyUploadedPackage, storeRelease, installRelease, trustDeveloperKey } = await releases();
    const { release, newKey } = await verifyUploadedPackage(db, await readPluginPackageZip(bytes), trust);
    const current = await getPluginInstallation(db, release.manifest.id);
    if (current?.source === "bundled") {
      throw new PluginError("installation_source_conflict", `${current.manifest.name} is compiled into this deployment: update it with pnpm plugin add, then deploy.`);
    }
    // Before anything is stored or trusted: an update keeps the developer the app was installed with.
    if (current) requirePinnedSigner(current, { source: "upload", signerKeyId: release.signer?.id ?? null });
    await storeRelease(c.env, release);
    if (newKey) await trustDeveloperKey(db, newKey);
    if (!current) {
      const installation = await installRelease(db, release, { source: "upload", actorUserId: actorId(c) });
      return ok(c, { app: await deps.detail(c, installation), updated: false, rolledBack: false, error: null });
    }
    const { updatePluginToRelease } = await lifecycle();
    const result = await updatePluginToRelease(
      deps.lifecycleContext(c) as never,
      current,
      { manifest: release.manifest, sha256: release.sha256, signerKeyId: release.signer?.id ?? null, source: "upload" },
      { expectedRevision: current.revision },
    );
    return ok(c, { app: await deps.detail(c, result.installation), updated: true, rolledBack: result.rolledBack, error: result.error });
  });

  // ── Emergency stop ──
  app.openapi(createRoute({
    method: "post",
    path: "/stop-third-party",
    operationId: "dashboard.apps.stop_third_party",
    tags: ["Admin - Apps"],
    summary: "Emergency stop: every running third-party app",
    description: "Stops every active app not published by Scalius at once, without running their code. Their data and settings stay; a Super Admin starts each again by approving it.",
    responses: {
      200: { description: "Stopped", content: { "application/json": { schema: successEnvelope(z.object({ stopped: z.array(z.string()) })) } } },
      ...mutationErrors,
    },
  }), async (c) => {
    noStore(c);
    const stopped = await stopThirdPartyPlugins(c.get("db"), "Stopped with the emergency switch for all third-party apps.");
    return ok(c, { stopped });
  });

  app.openapi(createRoute({
    method: "post",
    path: "/{id}/stop",
    operationId: "dashboard.apps.stop",
    tags: ["Admin - Apps"],
    summary: "Emergency stop: one app, at once",
    description: "Stops the app without running its code and without a revision check. Its data and settings stay; a Super Admin starts it again by approving it.",
    request: { params: idParams },
    responses: {
      200: { description: "Stopped", content: { "application/json": { schema: detailEnvelope({ stopped: z.boolean() }) } } },
      ...mutationErrors,
    },
  }), async (c) => {
    noStore(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await requirePluginInstallation(db, id);
    const stopped = await stopPlugin(db, id, "Stopped with the emergency switch.");
    return ok(c, { app: await deps.detail(c, await requirePluginInstallation(db, id)), stopped });
  });
}
