// apps/api/src/routes/admin/settings/platform.ts
// Settings -> System -> Platform: the deployment's public origins.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getPlatformSettings,
  invalidatePlatformConfigCache,
  savePlatformSettings,
} from "@scalius/core/modules/settings/platform-settings.service";
import {
  invalidateSiteSettingsCache,
  invalidateStorefrontUrlCache,
} from "@scalius/core/modules/settings";
import {
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  PLATFORM_URL_KEYS,
  PLATFORM_URL_MAX_LENGTH,
  dashboardBasePathFromUrl,
  getPlatformConfigReadiness,
} from "@scalius/shared/platform-config";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import { ok } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";

const app = new OpenAPIHono<{ Bindings: Env }>();

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
  .extend({ identityHandoff: identityHandoffSchema.partial().optional() });

function respond(
  c: Context<{ Bindings: Env }>,
  stored: Awaited<ReturnType<typeof getPlatformSettings>>,
) {
  const effective = c.env.PLATFORM_CONFIG;
  return ok(c, {
    ...stored,
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
  const stored = await getPlatformSettings(c.get("db"));
  return respond(c, stored);
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
  },
});

app.openapi(updatePlatformRoute, async (c) => {
  const db = c.get("db");
  const patch = c.req.valid("json");
  const stored = await savePlatformSettings(db, patch);

  const kv = c.env.CACHE;
  await Promise.all([
    invalidatePlatformConfigCache(kv),
    invalidateSiteSettingsCache(kv),
    invalidateStorefrontUrlCache(kv),
  ]);
  await bumpCacheGeneration(c);

  c.header("Cache-Control", "private, no-store");
  return respond(c, stored);
});

export { app as platformSettingsRoutes };
export default app;
