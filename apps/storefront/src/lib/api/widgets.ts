// src/lib/api/widgets.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { ApiWidget } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

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
        const url = createApiUrl("/widgets/active/homepage");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: { widgets: ApiWidget[] } = await response.json();
        return data.widgets;
      } catch (error) {
        console.error("Error fetching active homepage widgets:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG }, // 24 hours - purge-cache handles invalidation
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
        const url = createApiUrl(`/widgets/${widgetId}`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`API error: ${response.status}`);
        }

        const data: { widget: ApiWidget; success: boolean } =
          await response.json();
        return data.success ? data.widget : null;
      } catch (error) {
        console.error(`Error fetching widget by ID "${widgetId}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
