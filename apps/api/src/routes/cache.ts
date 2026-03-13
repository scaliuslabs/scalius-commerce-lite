// src/server/routes/cache.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCacheByPattern, getCacheStats } from "../utils/kv-cache";
import {
  INVALIDATION_GROUPS,
  ADMIN_PATH_TO_GROUPS,
  invalidateGroups,
  shouldBumpStorefrontVersion,
  getStorefrontPrefixesForGroups,
} from "../utils/cache-invalidation";
import { ValidationError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

function kv(c: { env: Env }): KVNamespace | undefined {
  return (c.env as any)?.CACHE as KVNamespace | undefined;
}

// ─── GET /stats ──────────────────────────────────────────────────────────────

const getStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Cache"],
  summary: "Get cache statistics",
  responses: {
    200: { description: "Cache stats", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(getStatsRoute, async (c) => {
  const stats = await getCacheStats(kv(c));
  return c.json({ success: true, stats }, 200);
});

// ─── GET /groups ─────────────────────────────────────────────────────────────

const getGroupsRoute = createRoute({
  method: "get",
  path: "/groups",
  tags: ["Cache"],
  summary: "Get invalidation group definitions and path mapping",
  responses: {
    200: { description: "Cache groups", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(getGroupsRoute, async (c) => {
  return c.json({
    success: true,
    groups: INVALIDATION_GROUPS,
    pathMapping: ADMIN_PATH_TO_GROUPS,
  }, 200);
});

// ─── GET /last-cleared ───────────────────────────────────────────────────────

const getLastClearedRoute = createRoute({
  method: "get",
  path: "/last-cleared",
  tags: ["Cache"],
  summary: "Get last-cleared timestamps for each group",
  responses: {
    200: { description: "Last cleared timestamps", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(getLastClearedRoute, async (c) => {
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

  return c.json({ success: true, timestamps }, 200);
});

// ─── POST /clear ─────────────────────────────────────────────────────────────

const clearAllRoute = createRoute({
  method: "post",
  path: "/clear",
  tags: ["Cache"],
  summary: "Clear all cache",
  responses: {
    200: { description: "Cache cleared", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(clearAllRoute, async (c) => {
  await deleteCacheByPattern("api:*", kv(c));

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

  return c.json({ success: true, message: "All cache cleared successfully" }, 200);
});

// ─── POST /clear-group ───────────────────────────────────────────────────────

const clearGroupRoute = createRoute({
  method: "post",
  path: "/clear-group",
  tags: ["Cache"],
  summary: "Clear cache for specific groups",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            groups: z.array(z.string()).min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Group cache cleared", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid groups", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(clearGroupRoute, async (c) => {
  const body = c.req.valid("json");
  const groups: string[] = body.groups || [];

  if (!groups.length) {
    throw new ValidationError("No groups specified");
  }

  const validGroups = groups.filter((g) => g in INVALIDATION_GROUPS);
  if (!validGroups.length) {
    throw new ValidationError("No valid groups specified");
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
  }, 200);
});

export { app as cacheControlRoutes };
