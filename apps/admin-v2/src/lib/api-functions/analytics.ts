import { createServerFn } from "@tanstack/react-start";
import type {
  AnalyticsProviderHealthResponse,
  AnalyticsScript,
  AnalyticsScriptSummary,
  AnalyticsScriptsListResponse,
} from "~/types/api-responses";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export interface AnalyticsQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  type?: string;
  status?: "active" | "inactive";
  sort?: string;
  order?: "asc" | "desc";
  showTrashed?: boolean;
}

export type CreateAnalyticsScriptInput = Record<string, unknown>;
export type UpdateAnalyticsScriptInput = {
  id: string;
  expectedRevision: number;
} & Record<string, unknown>;
export interface AnalyticsRevisionClaim {
  id: string;
  expectedRevision: number;
}
export type ToggleAnalyticsScriptInput = AnalyticsRevisionClaim & {
  isActive: boolean;
  allowDuplicateProvider?: boolean;
};

type CreateAnalyticsScriptPayload = {
  id: string;
  revision: number;
  script: AnalyticsScript | null;
};
type UpdateAnalyticsScriptPayload = { script: AnalyticsScript };
type ToggleAnalyticsScriptPayload = { message: string; script: AnalyticsScript };

function toAnalyticsParams(input: AnalyticsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.type) params.type = input.type;
  if (input.status) params.status = input.status;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed) params.trashed = "true";
  return params;
}

export const getAnalyticsScripts = createServerFn({ method: "GET" })
  .validator((data: AnalyticsQueryInput) => data)
  .handler(async ({ data }) => apiGet<AnalyticsScriptsListResponse>(
    "/analytics",
    toAnalyticsParams(data),
  ));

export const getAnalyticsProviderHealth = createServerFn({ method: "GET" }).handler(
  async () => apiGet<AnalyticsProviderHealthResponse>("/analytics/health"),
);

export const getAnalyticsScript = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => apiGet<AnalyticsScript>(`/analytics/${data.id}/source`));

export const createAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: CreateAnalyticsScriptInput) => data)
  .handler(async ({ data }) => apiPost<CreateAnalyticsScriptPayload>("/analytics", data));

export const updateAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: UpdateAnalyticsScriptInput) => data)
  .handler(async ({ data }) => apiPut<UpdateAnalyticsScriptPayload>(
    `/analytics/${data.id}`,
    data,
  ));

export const deleteAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: AnalyticsRevisionClaim) => data)
  .handler(async ({ data }) => apiDelete<AnalyticsScriptSummary>(
    `/analytics/${data.id}`,
    { expectedRevision: data.expectedRevision },
  ));

export const restoreAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: AnalyticsRevisionClaim) => data)
  .handler(async ({ data }) => apiPost<AnalyticsScriptSummary>(
    `/analytics/${data.id}/restore`,
    { expectedRevision: data.expectedRevision },
  ));

export const permanentlyDeleteAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: AnalyticsRevisionClaim) => data)
  .handler(async ({ data }) => apiDelete<{ id: string }>(
    `/analytics/${data.id}/permanent`,
    { expectedRevision: data.expectedRevision },
  ));

export const toggleAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: ToggleAnalyticsScriptInput) => data)
  .handler(async ({ data }) => apiPost<ToggleAnalyticsScriptPayload>(
    `/analytics/${data.id}/toggle`,
    {
      isActive: data.isActive,
      expectedRevision: data.expectedRevision,
      allowDuplicateProvider: data.allowDuplicateProvider ?? false,
    },
  ));
