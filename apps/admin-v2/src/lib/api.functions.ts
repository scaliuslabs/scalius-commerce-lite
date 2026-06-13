// @ts-nocheck - Remaining legacy server-function barrel still returns broad API shapes.
// Extracted slices should live under ./api-functions/** without file-level nocheck.
/**
 * TanStack Start server functions for ALL admin API endpoints.
 *
 * These replace the old Astro loaders (SSR) + api-browser.ts (client-side).
 * In TanStack Start, server functions are callable from anywhere:
 * route loaders, components, event handlers. On the client they become
 * fetch requests automatically.
 *
 * Grouped by domain. Each function wraps an API endpoint via the
 * server-only api.server.ts helpers.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
} from "./api.server";

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const getCustomers = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
      trashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed || data.trashed) params.trashed = "true";
    return apiGet<{ customers: unknown[]; pagination: unknown }>(
      "/customers",
      params,
    );
  });

export const getCustomer = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/customers/${data.id}`);
  });

export const getCustomerHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/customers/${data.id}/history`);
  });

export const createCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/customers", data);
  });

export const updateCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/customers/${data.id}`, data);
  });

export const deleteCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/customers/${data.id}`);
  });

export const permanentDeleteCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/customers/${data.id}/permanent`);
  });

export const deleteCustomerPermanent = permanentDeleteCustomer;

export const restoreCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/customers/${data.id}/restore`);
  });

export const bulkDeleteCustomers = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { customerIds: string[]; permanent?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost("/customers/bulk-delete", {
      customerIds: data.customerIds,
      permanent: data.permanent,
    });
  });

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const getWidgets = createServerFn({ method: "GET" })
  .inputValidator((data: { search?: string; showTrashed?: boolean }) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.search) params.search = data.search;
    if (data.showTrashed) params.trashed = "true";
    return apiGet<{
      widgets: unknown[];
      availableCollections: unknown[];
      availablePages?: unknown[];
      referencedProducts?: unknown[];
      referencedCategories?: unknown[];
    }>("/widgets", params);
  });

export const getWidgetPlacementTargets = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      type: "page" | "product" | "category" | "collection";
      search?: string;
      ids?: string[];
      limit?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = { type: data.type };
    if (data.search) params.search = data.search;
    if (data.ids?.length) params.ids = data.ids.join(",");
    if (data.limit) params.limit = String(data.limit);
    return apiGet<{
      targets: Array<{
        id: string;
        label: string;
        description: string | null;
        type: "page" | "product" | "category" | "collection";
      }>;
    }>("/widgets/placement-targets", params);
  });

export const getWidget = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/widgets/${data.id}`);
  });

export const createWidget = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/widgets", data);
  });

export const updateWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/widgets/${data.id}`, data);
  });

export const deleteWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.id}`);
  });

export const permanentDeleteWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.id}/permanent`);
  });

export const restoreWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.id}/restore`);
  });

// ─── Widget History ──────────────────────────────────────────────

export const getWidgetHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { widgetId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/widgets/${data.widgetId}/history`);
  });

export const createWidgetHistorySnapshot = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      widgetId: string;
      snapshot: {
        reason?: string;
        htmlContent?: string;
        cssContent?: string | null;
        jsContent?: string | null;
      };
    }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.widgetId}/history`, data.snapshot);
  });

export const restoreWidgetHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { widgetId: string; historyId: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.widgetId}/history/restore`, {
      historyId: data.historyId,
    });
  });

export const deleteWidgetHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { widgetId: string; historyId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.widgetId}/history/${data.historyId}`);
  });

export const bulkDeleteWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-delete", data);
  });

export const bulkRestoreWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-restore", data);
  });

export const bulkActivateWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-activate", data);
  });

export const bulkDeactivateWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-deactivate", data);
  });
