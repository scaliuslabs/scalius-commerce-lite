// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";

export type { AppType } from "./app";

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    const { default: app } = await import("./app");
    return app.fetch(request, this.env, this.ctx);
  }

  // Queues: payment events, OTP, notifications, storefront cache purge
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    const { handleQueueBatch } = await import("./queue-consumer");
    return handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], this.env, this.ctx);
  }

  // Cron: release orphaned reservations, archive stale incomplete online orders, and flush outboxes.
  async scheduled(controller: ScheduledController): Promise<void> {
    const { runScheduledMaintenance } = await import("./scheduled-maintenance");
    await runScheduledMaintenance(this.env, this.ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
  }
}
