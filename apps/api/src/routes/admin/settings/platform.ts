// apps/api/src/routes/admin/settings/platform.ts
// Settings -> System -> Platform: the deployment's public origins.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getPlatformSettingsDocument, savePlatformSettings } from "@scalius/core/modules/platform";
import {
  type PlatformConfig,
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  PLATFORM_URL_KEYS,
  PLATFORM_URL_MAX_LENGTH,
  dashboardBasePathFromUrl,
  getPlatformConfigReadiness,
} from "@scalius/shared/platform-config";

import { ok } from "../../../utils/api-response";
import { successEnvelope, conflictResponse, errorResponses } from "../../../schemas/responses";
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
  const saved = await savePlatformSettings(c.get("db"), patch, c.env.CACHE, { expectedRevision });

  c.header("Cache-Control", "private, no-store");
  return respond(c, saved);
});

export { app as platformSettingsRoutes };
export default app;
