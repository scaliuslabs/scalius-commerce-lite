import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { archiveStaleIncompleteOrders } from "@scalius/core/modules/orders/stale-incomplete-orders";
import { flushPendingOrderNotificationOutbox } from "@scalius/core/modules/notifications";
import { invalidateProductAvailabilityCaches } from "./utils/cache-invalidation";

export const INVENTORY_EXPIRY_SWEEP_LIMIT = 50;
export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT = 10;

export async function runScheduledMaintenance(env: Env, executionCtx: ExecutionContext): Promise<void> {
  const db = getDb(env);
  const result = await releaseExpiredReservations(db, 30, {
    limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
  });
  if (result.releasedVariantIds.length > 0) {
    await invalidateProductAvailabilityCaches(
      db,
      { variantIds: result.releasedVariantIds },
      { env, executionCtx },
    );
  }

  const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
  const staleIncompleteOrders = await archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
    limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  });
  if (staleIncompleteOrders.archivedOrderIds.length > 0) {
    await invalidateProductAvailabilityCaches(
      db,
      { orderIds: staleIncompleteOrders.archivedOrderIds },
      { env, executionCtx },
    );
  }
  if (
    staleIncompleteOrders.found > 0 ||
    staleIncompleteOrders.failed > 0 ||
    staleIncompleteOrders.hasMore
  ) {
    console.log(
      `[scheduled] Stale incomplete order cleanup: found=${staleIncompleteOrders.found}, ` +
        `archived=${staleIncompleteOrders.archived}, failed=${staleIncompleteOrders.failed}, ` +
        `limit=${staleIncompleteOrders.limit}, hasMore=${staleIncompleteOrders.hasMore}`,
    );
  }

  console.log(
    `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
      `, limit=${result.limit}, hasMore=${result.hasMore}` +
      (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
  );

  const notificationOutbox = await flushPendingOrderNotificationOutbox({
    db,
    queue: env.ORDER_NOTIFICATIONS_QUEUE,
    limit: ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
  });
  if (notificationOutbox.scanned > 0 || notificationOutbox.failed > 0) {
    console.log(
      `[scheduled] Notification outbox flush: scanned=${notificationOutbox.scanned}, ` +
        `enqueued=${notificationOutbox.enqueued}, failed=${notificationOutbox.failed}, skipped=${notificationOutbox.skipped}`,
    );
  }
}
