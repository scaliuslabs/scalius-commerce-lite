// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { handleQueueBatch } from "./queue-consumer";
import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { flushPendingOrderNotificationOutbox } from "@scalius/core/modules/notifications";
import { invalidateProductAvailabilityCaches } from "./utils/cache-invalidation";
export { WidgetDesignAgent } from "./agents/widget-design-agent";

export type { AppType } from "./app";

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  // Queues: payment events, order ingest, OTP, notifications
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    return handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], this.env, this.ctx);
  }

  // Cron: release orphaned reservation movements every 15 minutes
  async scheduled(_controller: ScheduledController): Promise<void> {
    const db = getDb(this.env);
    const result = await releaseExpiredReservations(db, 30);
    if (result.releasedVariantIds.length > 0) {
      await invalidateProductAvailabilityCaches(
        db,
        { variantIds: result.releasedVariantIds },
        { env: this.env, executionCtx: this.ctx },
      );
    }

    console.log(
      `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
        (result.errors.length > 0 ? `, errors=${result.errors.length}` : "")
    );

    const notificationOutbox = await flushPendingOrderNotificationOutbox({
      db,
      queue: this.env.ORDER_NOTIFICATIONS_QUEUE,
      limit: 10,
    });
    if (notificationOutbox.scanned > 0 || notificationOutbox.failed > 0) {
      console.log(
        `[scheduled] Notification outbox flush: scanned=${notificationOutbox.scanned}, ` +
          `enqueued=${notificationOutbox.enqueued}, failed=${notificationOutbox.failed}, skipped=${notificationOutbox.skipped}`,
      );
    }
  }
}
