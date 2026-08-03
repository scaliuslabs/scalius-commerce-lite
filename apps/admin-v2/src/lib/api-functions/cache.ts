import { createServerFn } from "@tanstack/react-start";
import { apiBaseGet, apiBasePost } from "../api.server";

export interface CacheGroupDefinition {
  label: string;
  description: string;
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
}

export const getCacheGroups = createServerFn({ method: "GET" }).handler(
  async () => apiBaseGet<CacheGroupsPayload>("/cache/groups"),
);

export const clearCache = createServerFn({ method: "POST" }).handler(
  async () => apiBasePost<ClearCachePayload>("/cache/clear"),
);

export const clearCacheGroup = createServerFn({ method: "POST" })
  .validator((data: { groupName: string }) => data)
  .handler(async ({ data }) =>
    apiBasePost<ClearCacheGroupPayload>("/cache/clear-group", {
      groups: [data.groupName],
    }),
  );
