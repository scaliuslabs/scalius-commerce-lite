// apps/api/src/routes/platform.ts
// Public platform origins. The storefront and dashboard Workers read this at
// request time instead of carrying their own URL configuration.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { EMPTY_PLATFORM_CONFIG } from "@scalius/shared/platform-config";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

export const publicPlatformConfigSchema = z.object({
  storefrontUrl: z.string(),
  apiUrl: z.string(),
  dashboardUrl: z.string(),
  mediaUrl: z.string(),
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
  const platform = c.env.PLATFORM_CONFIG ?? EMPTY_PLATFORM_CONFIG;
  c.header("Cache-Control", "public, max-age=60");
  return ok(c, {
    storefrontUrl: platform.storefrontUrl,
    apiUrl: platform.apiUrl,
    dashboardUrl: platform.dashboardUrl,
    mediaUrl: platform.mediaUrl,
  });
});

export { app as platformRoutes };
export default app;
