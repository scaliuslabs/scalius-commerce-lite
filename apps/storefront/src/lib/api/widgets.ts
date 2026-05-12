// src/lib/api/widgets.ts

import { getConfiguredSdkClient } from "./client";
import type { ApiWidget } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import {
  getApiV1WidgetsActiveHomepage,
  getApiV1WidgetsActiveScopeByScope,
  getApiV1WidgetsById,
} from "@scalius/api-client/sdk";

type ScopedWidgetScope = "homepage" | "page" | "product" | "category" | "collection";

/**
 * Fetches all widgets that are active and configured for the homepage.
 * The widgets are pre-sorted by their placement rule and sort order.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 *
 * @returns A promise resolving to an array of ApiWidget objects or null on failure.
 */
export async function getActiveHomepageWidgets(): Promise<ApiWidget[] | null> {
  return withEdgeCache(
    "global_homepage_widgets",
    async () => {
      try {
        const { data } = await getApiV1WidgetsActiveHomepage({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<{ widgets: ApiWidget[] }>(data)?.widgets ?? null;
      } catch (error: unknown) {
        console.error("Error fetching active homepage widgets:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

export async function getActiveWidgetsForScope(
  scope: ScopedWidgetScope,
  scopeId?: string | null,
): Promise<ApiWidget[] | null> {
  if (scope !== "homepage" && !scopeId) {
    console.error("getActiveWidgetsForScope: scopeId is required for scoped widgets.");
    return null;
  }

  return withEdgeCache(
    `widgets_scope_${scope}_${scopeId ?? "global"}`,
    async () => {
      try {
        const { data, error } = await getApiV1WidgetsActiveScopeByScope({
          client: getConfiguredSdkClient(),
          path: { scope },
          query: scope === "homepage" ? {} : { scopeId: scopeId ?? undefined },
        });
        if (error) return null;
        return unwrapData<{ widgets: ApiWidget[] }>(data)?.widgets ?? null;
      } catch (error: unknown) {
        console.error(`Error fetching active ${scope} widgets:`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a single widget by its unique ID.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 *
 * @param widgetId The ID of the widget to retrieve.
 * @returns A promise resolving to a single ApiWidget object or null if not found.
 */
export async function getWidgetById(
  widgetId: string,
): Promise<ApiWidget | null> {
  if (!widgetId) {
    console.error("getWidgetById: widgetId is required.");
    return null;
  }

  return withEdgeCache(
    `widget_${widgetId}`,
    async () => {
      try {
        const { data, error } = await getApiV1WidgetsById({
          client: getConfiguredSdkClient(),
          path: { id: widgetId },
        });
        if (error) return null;
        return unwrapData<{ widget: ApiWidget }>(data)?.widget ?? null;
      } catch (error: unknown) {
        console.error(`Error fetching widget by ID "${widgetId}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
