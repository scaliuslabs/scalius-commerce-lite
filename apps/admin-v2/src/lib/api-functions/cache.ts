import { createServerFn } from "@tanstack/react-start";
import { apiBaseGet, apiBasePost } from "../api.server";

export interface CacheStats {
  size: number;
  memory: string;
  hitRate?: string;
  missRate?: string;
  uptime: string;
  cacheType?: string;
}

export interface CacheGroupDefinition {
  label: string;
  description: string;
  kvPrefixes: string[];
  bumpsHtml: boolean;
  storefrontPrefixes: string[];
}

interface CacheStatsPayload {
  stats: CacheStats;
}

export interface CacheLastClearedPayload {
  timestamps: Record<string, number | null>;
}

export interface CacheGroupsPayload {
  groups: Record<string, CacheGroupDefinition>;
  pathMapping: Record<string, string[]>;
}

export interface ClearCachePayload {
  message?: string;
}

export interface ClearCacheGroupPayload {
  message: string;
  groups: string[];
  bumpedHtml: boolean;
}

export type StorefrontCacheDlqStatus = "pending" | "replayed" | "ignored";

export interface StorefrontCacheQueueFailureRecord {
  id: string;
  queueName: string;
  queueMessageId: string;
  messageType: string;
  operationId: string | null;
  source: string | null;
  attempts: number;
  status: StorefrontCacheDlqStatus;
  lastError: string | null;
  replayCount: number;
  messageTimestamp: number | null;
  failedAt: number;
  replayedAt: number | null;
  replayedBy: string | null;
  ignoredAt: number | null;
  ignoredBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StorefrontCachePurgeQueuePayload {
  type: "storefront.cache_purge";
  operationId: string;
  groups: string[];
  prefixes: string[];
  exactKeys?: string[];
  htmlPaths?: string[];
  bumpVersion: boolean;
  source: string;
  requestedAt: number;
}

export interface StorefrontCacheWarmQueuePayload {
  type: "storefront.cache_warm";
  operationId: string;
  paths: string[];
  source: string;
  requestedAt: number;
}

export type StorefrontCacheQueueFailurePayload =
  | StorefrontCachePurgeQueuePayload
  | StorefrontCacheWarmQueuePayload;

export interface StorefrontCacheQueueFailureDetail
  extends StorefrontCacheQueueFailureRecord {
  payload: StorefrontCacheQueueFailurePayload;
}

export interface StorefrontCacheDlqPayload {
  failures: StorefrontCacheQueueFailureRecord[];
}

export interface StorefrontCacheDlqQueryInput {
  status?: StorefrontCacheDlqStatus;
  limit?: number;
}

export interface StorefrontCacheDlqActionPayload {
  message: string;
  failure: StorefrontCacheQueueFailureRecord;
}

export interface StorefrontCacheDlqReplayPayload {
  message: string;
  failure: StorefrontCacheQueueFailureDetail;
}

function storefrontDlqQueryParams(
  input: StorefrontCacheDlqQueryInput,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.status) params.status = input.status;
  if (input.limit !== undefined) params.limit = String(input.limit);
  return params;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export const getCacheStats = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<CacheStatsPayload>("/cache/stats");
  },
);

export const getCacheLastCleared = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<CacheLastClearedPayload>("/cache/last-cleared");
  },
);

export const getCacheGroups = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<CacheGroupsPayload>("/cache/groups");
  },
);

export const getStorefrontCacheDlq = createServerFn({ method: "GET" })
  .validator((data: StorefrontCacheDlqQueryInput | undefined) => data ?? {})
  .handler(async ({ data }) => {
    return apiBaseGet<StorefrontCacheDlqPayload>(
      "/cache/storefront-dlq",
      storefrontDlqQueryParams(data),
    );
  });

export const clearCache = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiBasePost<ClearCachePayload>("/cache/clear");
  },
);

export const clearCacheGroup = createServerFn({ method: "POST" })
  .validator((data: { groupName: string }) => data)
  .handler(async ({ data }) => {
    return apiBasePost<ClearCacheGroupPayload>("/cache/clear-group", {
      groups: [data.groupName],
    });
  });

export const replayStorefrontCacheDlqFailure = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiBasePost<StorefrontCacheDlqReplayPayload>(
      `/cache/storefront-dlq/${encodePathSegment(data.id)}/replay`,
    );
  });

export const ignoreStorefrontCacheDlqFailure = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiBasePost<StorefrontCacheDlqActionPayload>(
      `/cache/storefront-dlq/${encodePathSegment(data.id)}/ignore`,
    );
  });
