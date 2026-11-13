// apps/api/src/routes/admin/settings/platform.ts
// Settings > Store details > Web addresses: the deployment's public origins.
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "../admin-router";
import type { Context } from "hono";
import { getPlatformSettingsDocument, savePlatformSettings } from "@scalius/core/modules/platform";
import { settingsMirror } from "@scalius/core/settings-store";
import {
  type PlatformConfig,
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  PLATFORM_URL_KEYS,
  PLATFORM_URL_MAX_LENGTH,
  dashboardBasePathFromUrl,
  getPlatformConfigReadiness,
} from "@scalius/shared/platform-config";
import { checkOutboundUrl } from "@scalius/shared/outbound-url";
import { providerFetch } from "@scalius/core/integrations/provider-fetch";

import { ok } from "../../../utils/api-response";
import { successEnvelope, conflictResponse, errorResponses } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";

const app = adminRouter();

const identityHandoffSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH),
  audience: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH),
  jwksUrl: z.string().max(PLATFORM_URL_MAX_LENGTH),
  localLoginDisabled: z.boolean(),
});

const platformSettingsSchema = z.object({
  storefrontUrl: z.string().max(PLATFORM_URL_MAX_LENGTH),
  apiUrl: z.string().max(PLATFORM_URL_MAX_LENGTH),
  dashboardUrl: z.string().max(PLATFORM_URL_MAX_LENGTH),
  mediaUrl: z.string().max(PLATFORM_URL_MAX_LENGTH),
  customerAuthCookieDomain: z.string().max(253),
  corsAllowedOrigins: z.array(z.string().max(PLATFORM_URL_MAX_LENGTH)).max(PLATFORM_CORS_ORIGINS_MAX_COUNT),
  /** Opt-in automation contracts (issue #358). Off by default. */
  setupTokenRequired: z.boolean(),
  identityHandoff: identityHandoffSchema,
});

const platformSettingsResponseSchema = platformSettingsSchema.extend({
  revision: z.number().int().nonnegative(),
  readiness: readinessSchema.extend({
    /** Typed extra: exactly which platform origins are still unset. */
    missing: z.array(z.enum(PLATFORM_URL_KEYS)),
  }),
  /** Origins the current request resolved, including local development defaults. */
  effective: z.object({
    storefrontUrl: z.string(),
    apiUrl: z.string(),
    dashboardUrl: z.string(),
    mediaUrl: z.string(),
  }),
  /** Runtime base path ("" at a host root) derived from the stored dashboard URL. */
  dashboardBasePath: z.string(),
});

const updatePlatformSettingsSchema = platformSettingsSchema
  .partial()
  .extend({
    identityHandoff: identityHandoffSchema.partial().optional(),
    expectedRevision: z.number().int().nonnegative(),
  });

function respond(
  c: Context<{ Bindings: Env }>,
  { value: stored, revision }: { value: PlatformConfig; revision: number },
) {
  const effective = c.env.PLATFORM_CONFIG;
  return ok(c, {
    ...stored,
    revision,
    readiness: getPlatformConfigReadiness(stored),
    effective: {
      storefrontUrl: effective?.storefrontUrl ?? stored.storefrontUrl,
      apiUrl: effective?.apiUrl ?? stored.apiUrl,
      dashboardUrl: effective?.dashboardUrl ?? stored.dashboardUrl,
      mediaUrl: effective?.mediaUrl ?? stored.mediaUrl,
    },
    dashboardBasePath: dashboardBasePathFromUrl(stored.dashboardUrl),
  });
}

const getPlatformRoute = createRoute({
  method: "get",
  path: "/platform",
  tags: ["Admin - Settings"],
  summary: "Get platform origins",
  operationId: "dashboard.settings.platform_get",
  responses: {
    200: {
      description: "Platform origins",
      content: { "application/json": { schema: successEnvelope(platformSettingsResponseSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(getPlatformRoute, async (c) => {
  c.header("Cache-Control", "private, no-store");
  return respond(c, await getPlatformSettingsDocument(c.get("db")));
});

const updatePlatformRoute = createRoute({
  method: "put",
  path: "/platform",
  tags: ["Admin - Settings"],
  summary: "Save platform origins",
  operationId: "dashboard.settings.platform_update",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updatePlatformSettingsSchema } },
    },
  },
  responses: {
    200: {
      description: "Platform origins saved",
      content: { "application/json": { schema: successEnvelope(platformSettingsResponseSchema) } },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(updatePlatformRoute, async (c) => {
  const { expectedRevision, ...patch } = c.req.valid("json");
  const saved = await savePlatformSettings(c.get("db"), patch, settingsMirror(c.env), { expectedRevision });

  c.header("Cache-Control", "private, no-store");
  return respond(c, saved);
});

/** The reachability check's deadline: long enough for a cold store, short enough for a settings screen. */
const STOREFRONT_CHECK_TIMEOUT_MS = 5_000;

const storefrontCheckRoute = createRoute({
  method: "post",
  path: "/platform/storefront-check",
  tags: ["Admin - Settings"],
  summary: "Check that the saved store address answers",
  description: "Asks the saved storefront URL's /health from the API (5 s, no redirect followed). `reachable` is null when the address is not a public https address the API may call.",
  operationId: "dashboard.settings.platform_storefront_check",
  responses: {
    200: {
      description: "Whether the store address answered",
      content: { "application/json": { schema: successEnvelope(z.object({ url: z.string(), reachable: z.boolean().nullable() })) } },
    },
    ...errorResponses,
  },
});

/** Whether the store answers at its saved address: from the API, so no browser policy or CORS blurs it. A redirect is an answer, never followed. */
async function storefrontAnswers(url: string, signal: AbortSignal): Promise<boolean | null> {
  const target = checkOutboundUrl(url);
  if (!target.ok) return null;
  try {
    const response = await providerFetch(new URL("/health", target.url), { redirect: "manual" }, { timeoutMs: STOREFRONT_CHECK_TIMEOUT_MS, signal });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  }
}

app.openapi(storefrontCheckRoute, async (c) => {
  const { value } = await getPlatformSettingsDocument(c.get("db"));
  c.header("Cache-Control", "private, no-store");
  return ok(c, { url: value.storefrontUrl, reachable: await storefrontAnswers(value.storefrontUrl, c.req.raw.signal) });
});

export { app as platformSettingsRoutes };
export default app;
