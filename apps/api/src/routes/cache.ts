// src/server/routes/cache.ts
import { Hono } from "hono";
import { deleteCacheByPattern, getCacheStats } from "../utils/kv-cache";
import {
  INVALIDATION_GROUPS,
  ADMIN_PATH_TO_GROUPS,
  invalidateGroups,
  shouldBumpStorefrontVersion,
  getStorefrontPrefixesForGroups,
} from "../utils/cache-invalidation";

const app = new Hono<{ Bindings: Env }>();

function kv(c: { env: Env }): KVNamespace | undefined {
  return (c.env as any)?.CACHE as KVNamespace | undefined;
}

// Get cache status and statistics
app.get("/stats", async (c) => {
  try {
    const stats = await getCacheStats(kv(c));
    return c.json({ success: true, stats });
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return c.json({ error: "Failed to get cache stats" }, 500);
  }
});

// Get invalidation group definitions and path mapping
app.get("/groups", async (c) => {
  return c.json({
    success: true,
    groups: INVALIDATION_GROUPS,
    pathMapping: ADMIN_PATH_TO_GROUPS,
  });
});

// Get last-cleared timestamps for each group
app.get("/last-cleared", async (c) => {
  try {
    const kvNs = kv(c);
    const groupNames = Object.keys(INVALIDATION_GROUPS);
    const timestamps: Record<string, number | null> = {};

    if (kvNs) {
      await Promise.all(
        groupNames.map(async (g) => {
          const val = await kvNs.get(`sc:_last_cleared:${g}`);
          timestamps[g] = val ? parseInt(val, 10) : null;
        }),
      );
    }

    return c.json({ success: true, timestamps });
  } catch (error) {
    console.error("Error getting last-cleared timestamps:", error);
    return c.json({ error: "Failed to get timestamps" }, 500);
  }
});

// Clear all cache
app.post("/clear", async (c) => {
  try {
    await deleteCacheByPattern("api:*", kv(c));

    // Also trigger storefront cache purge (full purge)
    const env = c.env as Env;
    const purgeUrl = env?.PURGE_URL;
    const purgeToken = env?.PURGE_TOKEN;
    if (purgeUrl && purgeToken) {
      const urlWithToken = new URL(purgeUrl);
      urlWithToken.searchParams.set("token", purgeToken);
      c.executionCtx.waitUntil(
        fetch(urlWithToken.toString(), { method: "GET" }).catch((err) =>
          console.error("[Cache] Storefront purge failed:", err),
        ),
      );
    }

    return c.json({ success: true, message: "All cache cleared successfully" });
  } catch (error) {
    console.error("Error clearing cache:", error);
    return c.json({ error: "Failed to clear cache" }, 500);
  }
});

// Clear cache for specific groups
app.post("/clear-group", async (c) => {
  try {
    const body = await c.req.json();
    const groups: string[] = body.groups || [];

    if (!groups.length) {
      return c.json({ error: "No groups specified" }, 400);
    }

    // Validate groups
    const validGroups = groups.filter((g) => g in INVALIDATION_GROUPS);
    if (!validGroups.length) {
      return c.json({ error: "No valid groups specified" }, 400);
    }

    await invalidateGroups(validGroups, kv(c));

    // Record last-cleared timestamps
    const now = Date.now().toString();
    const kvNs = kv(c);
    if (kvNs) {
      await Promise.all(
        validGroups.map((g) =>
          kvNs.put(`sc:_last_cleared:${g}`, now, { expirationTtl: 86400 * 30 }),
        ),
      );
    }

    // Trigger storefront purge if needed
    const bumpVersion = shouldBumpStorefrontVersion(validGroups);
    const prefixes = getStorefrontPrefixesForGroups(validGroups);
    const env = c.env as Env;
    const purgeUrl = env?.PURGE_URL;
    const purgeToken = env?.PURGE_TOKEN;
    if (purgeUrl && purgeToken) {
      const urlWithToken = new URL(purgeUrl);
      urlWithToken.searchParams.set("token", purgeToken);
      c.executionCtx.waitUntil(
        fetch(urlWithToken.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groups: validGroups, prefixes, bumpVersion }),
        }).catch((err) =>
          console.error("[Cache] Storefront group purge failed:", err),
        ),
      );
    }

    return c.json({
      success: true,
      message: `Cache cleared for groups: ${validGroups.join(", ")}`,
      groups: validGroups,
      bumpedHtml: bumpVersion,
    });
  } catch (error) {
    console.error("Error clearing group cache:", error);
    return c.json({ error: "Failed to clear group cache" }, 500);
  }
});

export { app as cacheControlRoutes };
