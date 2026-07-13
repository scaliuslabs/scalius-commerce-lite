// src/server/routes/cache.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCacheByPattern, getCacheStats } from "../utils/kv-cache";
import {
  INVALIDATION_GROUPS,
  ADMIN_PATH_TO_GROUPS,
  getOptionalExecutionContext,
  invalidateGroups,
  shouldBumpStorefrontVersion,
  triggerStorefrontPurgeForGroups
} from "../utils/cache-invalidation";
import {
  API_CACHE_FENCE_GLOBAL_SCOPE,
  bumpApiCacheFences,
  getMaxApiCacheFenceUpdatedAt,
} from "../utils/api-cache-fence";
import { ValidationError } from "../utils/api-error";
import { successEnvelope, messageResponse, errorResponses, conflictResponse, serviceUnavailableResponse } from "../schemas/responses";
import {
  ignoreStorefrontCacheQueueFailure,
  listStorefrontCacheQueueFailures,
  replayStorefrontCacheQueueFailure,
} from "../utils/storefront-cache-queue-failures";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

function kv(c: { env: Env }): KVNamespace | undefined {
  return c.env?.CACHE;
}

function adminActorId(c: { get: (key: "user") => unknown }): string | null {
  const user = c.get("user") as { id?: string; email?: string } | undefined;
  return user?.id ?? user?.email ?? null;
}

const storefrontCacheDlqStatusSchema = z.enum(["pending", "replayed", "ignored"]);

const storefrontCacheQueueFailureRecordSchema = z.object({
  id: z.string(),
  queueName: z.string(),
  queueMessageId: z.string(),
  messageType: z.string(),
  operationId: z.string().nullable(),
  source: z.string().nullable(),
  attempts: z.number(),
  status: storefrontCacheDlqStatusSchema,
  lastError: z.string().nullable(),
  replayCount: z.number(),
  messageTimestamp: z.number().nullable(),
  failedAt: z.number(),
  replayedAt: z.number().nullable(),
  replayedBy: z.string().nullable(),
  ignoredAt: z.number().nullable(),
  ignoredBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storefrontCacheQueueFailureDetailSchema = storefrontCacheQueueFailureRecordSchema.extend({
  payload: z.object({ type: z.string() }).passthrough(),
});

const storefrontCacheQueueFailureParamsSchema = z.object({
  id: z.string().min(1),
});

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
  // Preserve the declared operator-facing group order regardless of which KV
  // lookup resolves first (groups with no API prefixes resolve immediately).
  const timestamps: Record<string, number | null> = Object.fromEntries(
    groupNames.map((group) => [group, null]),
  );

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

// ─── GET /storefront-dlq ────────────────────────────────────────────────────

const listStorefrontCacheDlqRoute = createRoute({
  method: "get",
  path: "/storefront-dlq",
  tags: ["Cache"],
  summary: "List storefront cache queue failures",
  request: {
    query: z.object({
      status: storefrontCacheDlqStatusSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Storefront cache queue failures",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            failures: z.array(storefrontCacheQueueFailureRecordSchema),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(listStorefrontCacheDlqRoute, async (c) => {
  const query = c.req.valid("query");
  const failures = await listStorefrontCacheQueueFailures(c.get("db"), {
    status: query.status,
    limit: query.limit,
  });

  return ok(c, { failures });
});

// ─── POST /storefront-dlq/{id}/replay ───────────────────────────────────────

const replayStorefrontCacheDlqRoute = createRoute({
  method: "post",
  path: "/storefront-dlq/{id}/replay",
  tags: ["Cache"],
  summary: "Replay a storefront cache queue failure",
  request: {
    params: storefrontCacheQueueFailureParamsSchema,
  },
  responses: {
    200: {
      description: "Storefront cache queue failure replayed",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            message: z.string(),
            failure: storefrontCacheQueueFailureDetailSchema,
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

app.openapi(replayStorefrontCacheDlqRoute, async (c) => {
  const { id } = c.req.valid("param");
  const failure = await replayStorefrontCacheQueueFailure(
    c.get("db"),
    id,
    c.env.STOREFRONT_CACHE_QUEUE,
    adminActorId(c),
  );

  return ok(c, {
    message: "Storefront cache queue failure replayed.",
    failure,
  });
});

// ─── POST /storefront-dlq/{id}/ignore ───────────────────────────────────────

const ignoreStorefrontCacheDlqRoute = createRoute({
  method: "post",
  path: "/storefront-dlq/{id}/ignore",
  tags: ["Cache"],
  summary: "Ignore a storefront cache queue failure",
  request: {
    params: storefrontCacheQueueFailureParamsSchema,
  },
  responses: {
    200: {
      description: "Storefront cache queue failure ignored",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            message: z.string(),
            failure: storefrontCacheQueueFailureRecordSchema,
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(ignoreStorefrontCacheDlqRoute, async (c) => {
  const { id } = c.req.valid("param");
  const failure = await ignoreStorefrontCacheQueueFailure(
    c.get("db"),
    id,
    adminActorId(c),
  );

  return ok(c, {
    message: "Storefront cache queue failure ignored.",
    failure,
  });
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
  triggerStorefrontPurgeForGroups(
    groupNames,
    c.env,
    getOptionalExecutionContext(c),
  );

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
