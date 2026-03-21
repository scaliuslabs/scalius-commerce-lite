import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { analytics, type Analytics } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
import {
  processAnalyticsScript,
  shouldUsePartytown
} from "@scalius/core/integrations/analytics";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.NONE,
    keyPrefix: "api:analytics:",
    varyByQuery: false,
    methods: ["GET"]
  }),
);

// GET /analytics/configurations — get active analytics configurations
const getConfigurationsRoute = createRoute({
  method: "get",
  path: "/configurations",
  tags: ["Analytics"],
  summary: "Get active analytics configurations",
  responses: {
    200: {
      description: "Active analytics configurations",
      content: { "application/json": { schema: successEnvelope(z.object({
        analytics: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          config: z.string(),
          isActive: z.boolean(),
        }).passthrough()),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(getConfigurationsRoute, async (c) => {
  const db = c.get("db");
  const activeAnalyticsScriptsFromDB = await db
    .select()
    .from(analytics)
    .where(eq(analytics.isActive, true))
    .all();

  const processedScripts = activeAnalyticsScriptsFromDB.map(
    (script: Analytics) => {
      let processedConfig = script.config;
      if (shouldUsePartytown(script)) {
        processedConfig = processAnalyticsScript(script);
      }
      return {
        ...script,
        config: processedConfig
      };
    },
  );

  return ok(c, { analytics: processedScripts });
});

export { app as analyticsRoutes };
