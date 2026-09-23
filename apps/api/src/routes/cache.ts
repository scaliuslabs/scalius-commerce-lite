import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { bumpCacheGeneration } from "../utils/cache-generation";
import { ok } from "../utils/api-response";
import { errorResponses, messageResponse } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const refreshRoute = createRoute({
  method: "post",
  path: "/clear",
  tags: ["Cache"],
  summary: "Refresh the storefront",
  description:
    "Starts a new public cache generation. Saves already do this; use it only after changing data outside the dashboard.",
  operationId: "dashboard.cache.purge_all",
  responses: {
    200: {
      description: "New public cache generation started",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(refreshRoute, async (c) => {
  await bumpCacheGeneration(c);
  return ok(c, { message: "Store refreshed" });
});

export { app as cacheControlRoutes };
