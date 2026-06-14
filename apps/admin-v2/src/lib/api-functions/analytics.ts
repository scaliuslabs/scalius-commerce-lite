import { createServerFn } from "@tanstack/react-start";
import type { AnalyticsScript } from "~/types/api-responses";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

export type CreateAnalyticsScriptInput = Record<string, unknown>;
export type UpdateAnalyticsScriptInput = { id: string } & Record<string, unknown>;
export type AnalyticsScriptIdInput = { id: string };
export type ToggleAnalyticsScriptInput = { id: string; isActive: boolean };

type CreateAnalyticsScriptPayload = {
  id: string;
  script: AnalyticsScript | null;
};

type UpdateAnalyticsScriptPayload = {
  script: AnalyticsScript | null;
};

type DeleteAnalyticsScriptPayload = {
  message: string;
  deletedScript: AnalyticsScript | null;
};

type ToggleAnalyticsScriptPayload = {
  message: string;
  script: AnalyticsScript | null;
};

export const getAnalyticsScripts = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AnalyticsScript[]>("/analytics");
  },
);

export const getAnalyticsScript = createServerFn({ method: "GET" })
  .validator((data: AnalyticsScriptIdInput) => data)
  .handler(async ({ data }) => {
    return apiGet<AnalyticsScript>(`/analytics/${data.id}`);
  });

export const createAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: CreateAnalyticsScriptInput) => data)
  .handler(async ({ data }) => {
    return apiPost<CreateAnalyticsScriptPayload>("/analytics", data);
  });

export const updateAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: UpdateAnalyticsScriptInput) => data)
  .handler(async ({ data }) => {
    return apiPut<UpdateAnalyticsScriptPayload>(`/analytics/${data.id}`, data);
  });

export const deleteAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: AnalyticsScriptIdInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<DeleteAnalyticsScriptPayload>(`/analytics/${data.id}`);
  });

export const toggleAnalyticsScript = createServerFn({ method: "POST" })
  .validator((data: ToggleAnalyticsScriptInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ToggleAnalyticsScriptPayload>(`/analytics/${data.id}/toggle`, {
      isActive: data.isActive,
    });
  });
