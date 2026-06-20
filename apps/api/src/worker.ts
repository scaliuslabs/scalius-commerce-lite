// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { handleQueueBatch } from "./queue-consumer";
import { runScheduledMaintenance } from "./scheduled-maintenance";
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

  // Cron: release orphaned reservations, archive stale incomplete online orders, and flush outboxes.
  async scheduled(_controller: ScheduledController): Promise<void> {
    await runScheduledMaintenance(this.env, this.ctx);
  }
}
