// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import {
  DATABASE_MIGRATION_RETRY_AFTER_SECONDS,
  createDatabaseMigrationFreezeResponse,
  isDatabaseMigrationFrozen,
} from "@scalius/shared/database-migration-freeze";
import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
} from "./public-cache-policy";

export type { AppType } from "./app";
export { CheckoutCoordinator } from "./checkout-coordinator";

async function fetchApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { default: app } = await import("./app");
  const response = await app.fetch(request, env, ctx);
  return applyBaselineSecurityHeaders(request, response, {
    frameProtection: "deny",
  });
}

export class PublicApi extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const policy = getPublicApiCachePolicy(request);
    if (!policy) {
      return new Response("Request is not eligible for public caching", {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const response = await fetchApiApp(request, this.env, this.ctx);
    return decoratePublicApiResponse(response, policy);
  }
}

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const migrationResponse = createDatabaseMigrationFreezeResponse(
      request,
      this.env,
      { allowApiProbes: true },
    );
    if (migrationResponse) {
      return applyBaselineSecurityHeaders(request, migrationResponse, {
        frameProtection: "deny",
      });
    }

    const cachePolicy = getPublicApiCachePolicy(request);
    if (cachePolicy) {
      return this.ctx.exports.PublicApi.fetch(request);
    }

    return fetchApiApp(request, this.env, this.ctx);
  }

  // Queues: payment events, OTP, notifications, storefront cache purge
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    if (isDatabaseMigrationFrozen(this.env)) {
      batch.retryAll({
        delaySeconds: DATABASE_MIGRATION_RETRY_AFTER_SECONDS,
      });
      return;
    }

    const { handleQueueBatch } = await import("./queue-consumer");
    return handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], this.env, this.ctx);
  }

  // Cron: release orphaned reservations, archive stale incomplete online orders, and flush outboxes.
  async scheduled(controller: ScheduledController): Promise<void> {
    if (isDatabaseMigrationFrozen(this.env)) return;

    const { runScheduledMaintenance } = await import("./scheduled-maintenance");
    await runScheduledMaintenance(this.env, this.ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
  }
}
