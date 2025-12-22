import { Hono } from "hono";

import { analytics, type Analytics } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import {
  processAnalyticsScript,
  shouldUsePartytown,
} from "../../lib/analytics";

const app = new Hono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
    keyPrefix: "api:analytics:",
    varyByQuery: false, // Configs are global for now
    methods: ["GET"],
  }),
);

app.get("/configurations", async (c) => {
  try {
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
          config: processedConfig,
        };
      },
    );

    return c.json({ analytics: processedScripts });
  } catch (error) {
    console.error("Error fetching analytics configurations:", error);
    return c.json({ error: "Failed to fetch analytics configurations" }, 500);
  }
});

export { app as analyticsRoutes };
