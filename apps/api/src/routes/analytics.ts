import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { analytics } from "@scalius/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown
} from "@scalius/core/integrations/analytics";
import { normalizeCloudflareWebAnalyticsConfig } from "@scalius/core/modules/analytics/analytics.validation";

const app = new OpenAPIHono<{ Bindings: Env }>();

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
      let processedConfig = script.type === "cloudflare_web_analytics"
        ? normalizeCloudflareWebAnalyticsConfig(script.config)
        : script.config;
      const processedScript = { ...script, config: processedConfig };
      if (shouldUsePartytown(processedScript)) {
        processedConfig = processAnalyticsScript(processedScript);
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
