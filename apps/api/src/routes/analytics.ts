import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { analytics, type Analytics } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import {
  processAnalyticsScript,
  shouldUsePartytown
} from "@scalius/core/integrations/analytics";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
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
      description: "Active analytics configurations"
    },
    500: {
      description: "Server error"
    }
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

  return c.json({ analytics: processedScripts }, 200);
});

export { app as analyticsRoutes };
