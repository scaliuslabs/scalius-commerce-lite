// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";

export type { AppType } from "./app";

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const { default: app } = await import("./app");
    const response = await app.fetch(request, this.env, this.ctx);
    return applyBaselineSecurityHeaders(request, response, {
      frameProtection: "deny",
    });
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
