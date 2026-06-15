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
