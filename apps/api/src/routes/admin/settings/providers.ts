// The app providers of one port (`GET /admin/settings/providers?kind=`), for
// the settings page that offers that port's built-in providers: each
// installed app's provider with the same readiness the port's callers check
// (the app is active, approved for the port, runnable here, its settings
// complete and its secrets readable), and a test-connection action that runs
// the app's `testConnection` operation through the plugin host. Credentials
// stay in the app's own settings (encrypted, masked); nothing here reads or
// returns them.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { listPluginInstallations, type PluginInstallation } from "@scalius/core/modules/plugins";
import {
  PROVIDER_KINDS,
  parseQualifiedProviderId,
  providerErrorOf,
  qualifiedProviderId,
  type ProviderKind,
} from "@scalius/shared/plugins/providers/kinds";
import { declaredProviderOperations } from "@scalius/shared/plugins/providers";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { canUseProviderPort } from "@scalius/core/auth/rbac/provider-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../utils/api-error";
import { ok } from "../../../utils/api-response";
import { errorResponses, successEnvelope } from "../../../schemas/responses";
import { readAppProviderSettings, requestProviderRuntime } from "../../../plugins/providers/runtime";
import { pluginAssetUrl, providerIconUrl } from "../../../plugins/listing";
import { providerConnectionSchema } from "../../../schemas/app-settings";
import { providerConnections, recordProviderConnectionTest } from "../../../plugins/provider-connection";

const app = new OpenAPIHono<{ Bindings: Env }>();

const appProviderSchema = z.object({
  /** `<plugin id>:<provider id>`: what the port's settings store and orders record. */
  id: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  pluginId: z.string(),
  appName: z.string(),
  /** Same-origin address of the app's icon, shown beside the method (null: the app has none). */
  appIcon: z.string().nullable(),
  /** Same-origin address of the provider's own mark (a pack's couriers are different brands), else the app's icon. */
  icon: z.string().nullable(),
  name: z.string(),
  /** The port's optional operations the app implements. */
  operations: z.array(z.string()),
  canTestConnection: z.boolean(),
  readiness: z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    usable: z.boolean(),
    missingFields: z.array(z.string()),
    credentialErrors: z.array(z.string()),
    blockedReason: z.string().optional(),
  }),
  environment: z.enum(["test", "live", "unknown"]),
  connection: providerConnectionSchema,
});

/** Every installed app's providers of a port, the installations in plugin id order. */
function appProvidersOf(installations: readonly PluginInstallation[], kind: ProviderKind) {
  return installations
    .flatMap((installation) => installation.manifest.providers
      .filter((declaration) => declaration.kind === kind)
      .map((declaration) => ({ installation, declaration })));
}

const listRoute = createRoute({
  method: "get",
  path: "/providers",
  operationId: "dashboard.settings_providers.list",
  tags: ["Admin - Settings"],
  summary: "List the app providers of a port with their readiness",
  request: { query: z.object({ kind: z.enum(PROVIDER_KINDS) }) },
  responses: {
    200: {
      description: "App providers",
      content: { "application/json": { schema: successEnvelope(z.object({ providers: z.array(appProviderSchema) })) } },
    },
    ...errorResponses,
  },
});

app.openapi(listRoute, async (c) => {
  const { kind } = c.req.valid("query");
  // The same permission that reads this port's built-in providers.
  if (!canUseProviderPort(c.get("adminPermissions"), kind, "view")) {
    throw new ForbiddenError("You do not have permission to view these providers.");
  }
  const runtime = requestProviderRuntime(c);
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const db = c.get("db");
  const providers = await Promise.all(appProvidersOf(await listPluginInstallations(db), kind)
    .map(async ({ installation, declaration }) => {
      const [settings, connections] = await Promise.all([
        readAppProviderSettings(runtime, installation, declaration, encryptionKey),
        providerConnections(db, installation, [declaration]),
      ]);
      const operations = declaredProviderOperations(declaration);
      const configured = settings.missingFields.length === 0 && settings.credentialErrors.length === 0;
      return {
        id: qualifiedProviderId(installation.pluginId, declaration.id),
        kind,
        pluginId: installation.pluginId,
        appName: installation.manifest.name,
        appIcon: installation.manifest.icon ? pluginAssetUrl(installation.pluginId, "icon", installation.bundleSha256) : null,
        icon: providerIconUrl(installation.pluginId, installation.manifest, declaration.id, installation.bundleSha256),
        name: declaration.name,
        operations: [...operations],
        canTestConnection: operations.includes("testConnection"),
        readiness: {
          configured,
          enabled: settings.enabled,
          usable: configured && settings.enabled,
          missingFields: settings.missingFields,
          credentialErrors: settings.credentialErrors,
          ...(settings.blockedReason ? { blockedReason: settings.blockedReason } : {}),
        },
        environment: settings.environment,
        connection: connections.get(qualifiedProviderId(installation.pluginId, declaration.id))!,
      };
    }));
  return ok(c, { providers });
});

const testRoute = createRoute({
  method: "post",
  path: "/providers/{id}/test",
  operationId: "dashboard.settings_providers.test",
  tags: ["Admin - Settings"],
  summary: "Test an app provider's connection",
  request: { params: z.object({ id: z.string().max(160) }) },
  responses: {
    200: {
      description: "The provider's answer",
      content: { "application/json": { schema: successEnvelope(z.object({ ok: z.boolean(), message: z.string() })) } },
    },
    ...errorResponses,
  },
});

app.openapi(testRoute, async (c) => {
  const id = c.req.valid("param").id;
  const parsed = parseQualifiedProviderId(id);
  if (!parsed) throw new ValidationError("Name an app provider as <plugin id>:<provider id>.");
  const installations = await listPluginInstallations(c.get("db"));
  const installation = installations.find((candidate) => candidate.pluginId === parsed.pluginId);
  const declaration = installation?.manifest.providers.find((candidate) => candidate.id === parsed.providerId);
  if (!installation || !declaration) throw new NotFoundError("This app provider is not installed.");
  // The same permission that tests or saves this port's built-in providers.
  if (!canUseProviderPort(c.get("adminPermissions"), declaration.kind, "manage")) {
    throw new ForbiddenError("You do not have permission to test this provider.");
  }
  if (!declaredProviderOperations(declaration).includes("testConnection")) {
    throw new ValidationError(`${declaration.name} does not offer a connection test.`);
  }
  const runtime = requestProviderRuntime(c);
  const settings = await readAppProviderSettings(runtime, installation, declaration, getCredentialEncryptionKey(c.env as Record<string, unknown>));
  // Never call an app that could not run its real operations either.
  if (!settings.enabled || settings.missingFields.length > 0 || settings.credentialErrors.length > 0) {
    return ok(c, { ok: false, message: settings.blockedReason ?? `${declaration.name} is not ready.` });
  }
  try {
    const host = await runtime.host();
    const result = await host.invokeProvider(installation, declaration.kind, declaration.id, "testConnection", {});
    await recordProviderConnectionTest(c.get("db"), installation, declaration, result);
    return ok(c, { ok: result.ok, message: result.message });
  } catch (error) {
    const failure = providerErrorOf(error);
    if (!failure) throw error;
    // The host masks provider messages: they are merchant-safe.
    await recordProviderConnectionTest(c.get("db"), installation, declaration, { ok: false, message: failure.message });
    return ok(c, { ok: false, message: failure.message });
  }
});

export { app as appProviderSettingsRoutes };
