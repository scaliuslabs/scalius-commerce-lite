// src/server/routes/cache.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCacheByPattern, getCacheStats } from "../utils/kv-cache";
import {
  INVALIDATION_GROUPS,
  ADMIN_PATH_TO_GROUPS,
  invalidateGroups,
  normalizeStorefrontPurgeUrl,
  shouldBumpStorefrontVersion,
  triggerStorefrontPurgeForGroups
} from "../utils/cache-invalidation";
import {
  API_CACHE_FENCE_GLOBAL_SCOPE,
  bumpApiCacheFences,
  getMaxApiCacheFenceUpdatedAt,
} from "../utils/api-cache-fence";
import { ValidationError } from "../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

function kv(c: { env: Env }): KVNamespace | undefined {
  return c.env?.CACHE;
}

// ─── GET /stats ──────────────────────────────────────────────────────────────

const getStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Cache"],
  summary: "Get cache statistics",
  responses: {
    200: {
      description: "Cache stats",
      content: { "application/json": { schema: successEnvelope(z.object({ stats: z.object({}).passthrough() })) } },
    },
    ...errorResponses,
  },
});

app.openapi(getStatsRoute, async (c) => {
  const stats = await getCacheStats(kv(c));
  return ok(c, { stats });
});

// ─── GET /groups ─────────────────────────────────────────────────────────────

const getGroupsRoute = createRoute({
  method: "get",
  path: "/groups",
  tags: ["Cache"],
  summary: "Get invalidation group definitions and path mapping",
  responses: {
    200: {
      description: "Cache groups",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            groups: z.record(z.string(), z.unknown()),
            pathMapping: z.record(z.string(), z.unknown()),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getGroupsRoute, async (c) => {
  return ok(c, {
    groups: INVALIDATION_GROUPS,
    pathMapping: ADMIN_PATH_TO_GROUPS
  });
});

// ─── GET /last-cleared ───────────────────────────────────────────────────────

const getLastClearedRoute = createRoute({
  method: "get",
  path: "/last-cleared",
  tags: ["Cache"],
  summary: "Get last-cleared timestamps for each group",
  responses: {
    200: {
      description: "Last cleared timestamps",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            timestamps: z.record(z.string(), z.number().nullable()),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getLastClearedRoute, async (c) => {
  const kvNs = kv(c);
  const groupNames = Object.keys(INVALIDATION_GROUPS);
  const timestamps: Record<string, number | null> = {};

  if (kvNs) {
    await Promise.all(
      groupNames.map(async (g) => {
        timestamps[g] = await getMaxApiCacheFenceUpdatedAt(
          INVALIDATION_GROUPS[g]?.kvPrefixes ?? [],
          kvNs,
        );
      }),
    );
  }

  return ok(c, { timestamps });
});

// ─── POST /clear ─────────────────────────────────────────────────────────────

const clearAllRoute = createRoute({
  method: "post",
  path: "/clear",
  tags: ["Cache"],
  summary: "Clear all cache",
  responses: {
    200: {
      description: "Cache cleared",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(clearAllRoute, async (c) => {
  const kvNs = kv(c);
  const groupNames = Object.keys(INVALIDATION_GROUPS);
  const fenceScopes = [
    API_CACHE_FENCE_GLOBAL_SCOPE,
    ...new Set(
      groupNames.flatMap((group) => INVALIDATION_GROUPS[group]?.kvPrefixes ?? []),
    ),
  ];
  await bumpApiCacheFences(fenceScopes, kvNs);
  await deleteCacheByPattern("api:*", kvNs);

  const env = c.env as Env;
  const purgeUrl = env?.PURGE_URL;
  const purgeToken = env?.PURGE_TOKEN;
  if (purgeUrl && purgeToken) {
    c.executionCtx.waitUntil(
      fetch(normalizeStorefrontPurgeUrl(purgeUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${purgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bumpVersion: true }),
      }).catch((err) =>
        console.error("[Cache] Storefront purge failed:", err),
      ),
    );
  }

  return ok(c, { message: "All cache cleared successfully" });
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
            groups: z.array(z.string()).min(1)
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: "Group cache cleared",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            message: z.string(),
            groups: z.array(z.string()),
            bumpedHtml: z.boolean(),
          })),
        },
      },
    },
    ...errorResponses,
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

  const bumpVersion = shouldBumpStorefrontVersion(validGroups);
  triggerStorefrontPurgeForGroups(validGroups, c.env, c.executionCtx);

  return ok(c, {
    message: `Cache cleared for groups: ${validGroups.join(", ")}`,
    groups: validGroups,
    bumpedHtml: bumpVersion
  });
});

export { app as cacheControlRoutes };
