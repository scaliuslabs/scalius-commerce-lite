// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { handleQueueBatch } from "./queue-consumer";
import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
export { WidgetDesignAgent } from "./agents/widget-design-agent";

export type { AppType } from "./app";

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  // Queues: payment events, order ingest, OTP, notifications
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    return handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], this.env);
  }

  // Cron: release orphaned reservation movements every 15 minutes
  async scheduled(controller: ScheduledController): Promise<void> {
    const db = getDb(this.env);
    const result = await releaseExpiredReservations(db, 30);

    console.log(
      `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
        (result.errors.length > 0 ? `, errors=${result.errors.length}` : "")
    );
  }
}
