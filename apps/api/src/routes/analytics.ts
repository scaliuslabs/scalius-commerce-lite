import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { analytics } from "@scalius/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
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
          type: z.string(),
          config: z.string(),
          usePartytown: z.boolean(),
          location: z.string(),
        }).passthrough()),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(getConfigurationsRoute, async (c) => {
  const db = c.get("db");
  const activeAnalyticsScriptsFromDB = await db
    .select({
      id: analytics.id,
      type: analytics.type,
      config: analytics.config,
      isActive: analytics.isActive,
      usePartytown: analytics.usePartytown,
      location: analytics.location,
    })
    .from(analytics)
    .where(and(eq(analytics.isActive, true), isNull(analytics.deletedAt)))
    .all();

  const processedScripts = activeAnalyticsScriptsFromDB
    .filter(shouldInjectAnalyticsScript)
    .map((script) => {
      let processedConfig = script.config;
      if (shouldUsePartytown(script)) {
        processedConfig = processAnalyticsScript(script);
      }
      return {
        id: script.id,
        type: script.type,
        config: processedConfig,
        usePartytown: script.usePartytown,
        location: script.location,
      };
    });

  return ok(c, { analytics: processedScripts });
});

export { app as analyticsRoutes };
