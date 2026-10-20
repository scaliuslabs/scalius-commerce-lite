import type { MiddlewareHandler } from "hono";
import type { Database } from "@scalius/database/client";
import { collectRecommendationRefreshRequests } from "@scalius/core/utils/recommendation-requests";
import { afterResponse } from "../background/after-response";

/**
 * A public read never ranks recommendations live: a product found without a
 * stored list is served the fallback and noted during the render; after the
 * response it is queued for the rotation's refresh (one bounded statement,
 * catalog/recommendation-queue.ts). Requests that noted nothing do no work.
 */
export const recommendationQueueMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method !== "GET") return next();
  const { productIds } = await collectRecommendationRefreshRequests(() => next());
  if (productIds.length === 0) return;
  const db = c.get("db") as Database | undefined;
  if (!db) return;
  await afterResponse(c, "recommendation queue", async () => {
    const { enqueueRecommendationRefresh } = await import("@scalius/core/modules/catalog");
    await enqueueRecommendationRefresh(db, productIds);
  });
};
