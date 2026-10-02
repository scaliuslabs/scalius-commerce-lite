// Catalogue background jobs on JOBS_QUEUE:
//
//   catalog.recommendations.refresh  { productIds }       ≤ 20 products, one
//       ranking statement each (core catalog/recommendation-refresh.ts).
//   catalog.projections.rebuild      { afterProductId }   one keyset chunk of
//       the buyer-state/facet rebuild; the consumer enqueues the next chunk
//       with dependency changes committed by the database triggers.
//
// Producers never fail the write that triggered them: the enqueue is logged
// and dropped, and the nightly run (scheduled/catalog-projections.ts) heals.
import type { Database } from "@scalius/database/client";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import {
  recommendationRefreshTargets,
  refreshProductRecommendations,
} from "@scalius/core/modules/catalog";
import { planLimits } from "@scalius/shared/plan-limits";
import { getOptionalExecutionContext, type WaitUntilExecutionContext } from "./execution-context";
import { bulkQueueCapacity } from "./queue-lanes";

export type CatalogRecommendationsRefreshQueueMessage = {
  type: "catalog.recommendations.refresh";
  productIds: string[];
};

export type CatalogProjectionsRebuildQueueMessage = {
  type: "catalog.projections.rebuild";
  afterProductId: string | null;
};

export type CatalogQueueMessage =
  | CatalogRecommendationsRefreshQueueMessage
  | CatalogProjectionsRebuildQueueMessage;

/** Messages per `sendBatch` call (the Queues limit is 100). */
const QUEUE_SEND_BATCH = 50;

type CatalogJobQueue = Pick<Queue, "sendBatch" | "send" | "metrics">;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Enqueues recommendation refreshes for these products, as many products per
 * message as the plan profile allows, and no more messages than the bulk lane
 * has room for (utils/queue-lanes.ts): a refresh is recomputed by the nightly
 * pass, so what does not fit now is dropped, never queued behind urgent work.
 * Returns the messages enqueued.
 */
export async function enqueueRecommendationRefresh(
  queue: CatalogJobQueue | undefined,
  productIds: readonly string[],
): Promise<number> {
  if (!queue || productIds.length === 0) return 0;
  const room = await bulkQueueCapacity(queue);
  if (room === 0) return 0;
  const messages = chunks([...new Set(productIds)], planLimits().queue.recommendationProductsPerMessage)
    .slice(0, room)
    .map((ids): { body: CatalogRecommendationsRefreshQueueMessage } => ({
      body: { type: "catalog.recommendations.refresh", productIds: ids },
    }));
  for (const batch of chunks(messages, QUEUE_SEND_BATCH)) await queue.sendBatch(batch);
  return messages.length;
}

/**
 * After a catalogue write: refresh the written products' recommendations and
 * their bounded peers', off the request path. Never throws.
 */
export function scheduleRecommendationRefreshAfterWrite(
  c: { env: Env; executionCtx?: WaitUntilExecutionContext },
  db: Database,
  productIds: readonly string[],
): void {
  if (productIds.length === 0 || !c.env.JOBS_QUEUE) return;
  const work = (async () => {
    const targets = await recommendationRefreshTargets(db, productIds);
    await enqueueRecommendationRefresh(c.env.JOBS_QUEUE, targets);
  })().catch((error: unknown) => {
    console.warn("[catalog-jobs] recommendation refresh enqueue failed", {
      products: productIds.length,
      error: error instanceof Error ? error.name : "unknown",
    });
  });
  const executionCtx = getOptionalExecutionContext(c);
  if (executionCtx) executionCtx.waitUntil(work);
}

/** Starts (or continues) the queued projection rebuild. */
export async function enqueueCatalogProjectionRebuild(
  queue: CatalogJobQueue | undefined,
  afterProductId: string | null = null,
): Promise<boolean> {
  if (!queue) return false;
  const body: CatalogProjectionsRebuildQueueMessage = { type: "catalog.projections.rebuild", afterProductId };
  await queue.send(body);
  return true;
}

/** Queue consumer for the catalogue job types. */
export async function processCatalogQueueMessage(
  payload: CatalogQueueMessage,
  db: Database,
  env: Env,
): Promise<void> {
  if (payload.type === "catalog.recommendations.refresh") {
    const productIds = Array.isArray(payload.productIds)
      ? payload.productIds.filter((id): id is string => typeof id === "string")
      : [];
    await refreshProductRecommendations(db, productIds);
    return;
  }
  const after = typeof payload.afterProductId === "string" ? payload.afterProductId : null;
  const result = await rebuildCatalogProjections(db, {
    afterProductId: after,
    limit: planLimits().queue.catalogRebuildChunk,
  });
  if (!result.done) {
    await enqueueCatalogProjectionRebuild(env.JOBS_QUEUE, result.nextAfterProductId);
    return;
  }
  // The rebuild's atomic batches advance `store` only when they repair drift.
}
