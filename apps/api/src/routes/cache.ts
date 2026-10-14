import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { getDb } from "@scalius/database/client";
import { advanceCacheDeps } from "@scalius/database/cache-dep-writes";
import { ok } from "../utils/api-response";
import { errorResponses, messageResponse } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const refreshRoute = createRoute({
  method: "post",
  path: "/clear",
  tags: ["Cache"],
  summary: "Refresh the storefront",
  description:
    "Invalidates all public pages through the store dependency clock. Normal writes invalidate their affected data automatically.",
  operationId: "dashboard.cache.purge_all",
  responses: {
    200: {
      description: "Public store dependency advanced",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(refreshRoute, async (c) => {
  const db = getDb(c.env);
  await advanceCacheDeps(db, ["store"]);
  return ok(c, { message: "Store refreshed" });
});

export { app as cacheControlRoutes };
