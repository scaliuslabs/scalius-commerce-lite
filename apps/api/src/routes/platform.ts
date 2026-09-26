// apps/api/src/routes/platform.ts
// Public platform origins. The storefront Worker and the dashboard read this at
// request time instead of carrying their own URL configuration.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getPlatformSettings } from "@scalius/core/modules/platform";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

export const publicPlatformConfigSchema = z.object({
  storefrontUrl: z.string(),
  apiUrl: z.string(),
  /** May carry a path prefix when the dashboard is served below a host root. */
  dashboardUrl: z.string(),
  mediaUrl: z.string(),
  /** Opt-in automation contracts. Dashboard sign-in verifies handoff tokens with these. */
  setupTokenRequired: z.boolean(),
  identityHandoff: z.object({
    enabled: z.boolean(),
    issuer: z.string(),
    audience: z.string(),
    jwksUrl: z.string(),
    localLoginDisabled: z.boolean(),
  }),
});

const getPlatformRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.platform.get",
  tags: ["Platform"],
  summary: "Get the public origins of this deployment",
  responses: {
    200: {
      description: "Public platform origins",
      content: { "application/json": { schema: successEnvelope(publicPlatformConfigSchema) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(getPlatformRoute, async (c) => {
  // Worker-entry KV is an eventually consistent hint. Origin changes must be
  // visible on this configuration read immediately after a successful save.
  const platform = await getPlatformSettings(c.get("db"));
  c.header("Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
  return ok(c, {
    storefrontUrl: platform.storefrontUrl,
    apiUrl: platform.apiUrl,
    dashboardUrl: platform.dashboardUrl,
    mediaUrl: platform.mediaUrl,
    setupTokenRequired: platform.setupTokenRequired,
    identityHandoff: { ...platform.identityHandoff },
  });
});

export { app as platformRoutes };
export default app;
