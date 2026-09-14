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
import { describeMissingMasterSecret } from "@scalius/shared/runtime-secrets";
import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
  normalizePublicApiCacheTags,
} from "./public-cache-policy";
import { isAgentAccessPath } from "./agent-access/paths";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";
import { composeApiRuntimeEnv, hasMasterSecret } from "./runtime/runtime-env";

export type { AppType } from "./app";
export { CheckoutCoordinator } from "./checkout-coordinator";

const PROBE_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/health/",
  "/api/v1/readyz",
  "/api/v1/readyz/",
]);

function isProbePath(pathname: string): boolean {
  return PROBE_PATHS.has(pathname);
}

/**
 * Without the master secret no session, token, or purge auth can be verified.
 * Fail closed for everything except the health and readiness probes, which
 * report the missing secret so operators can see it.
 */
function missingMasterSecretResponse(request: Request): Response {
  const response = Response.json(
    {
      success: false,
      error: describeMissingMasterSecret(),
      code: "RUNTIME_SECRET_MISSING",
    },
    { status: 503, headers: { "Cache-Control": "private, no-store" } },
  );
  return applyBaselineSecurityHeaders(request, response, {
    frameProtection: "deny",
  });
}

async function fetchApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await fetchRuntimeApiApp(request, env, ctx);
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

    if (!hasMasterSecret(this.env)) return missingMasterSecretResponse(request);
    const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
    const response = await fetchApiApp(request, env, this.ctx);
    return decoratePublicApiResponse(response, policy);
  }

  async purgeGroups(groups: string[]): Promise<void> {
    const tags = normalizePublicApiCacheTags(groups);
    if (tags.length === 0) return;

    const cache = this.ctx.cache;
    if (!cache) return;

    const result = await cache.purge({ tags });
    if (!result.success) {
      const codes = result.errors.map((error) => error.code).join(",");
      throw new Error(`Public API cache purge failed (${codes || "unknown"})`);
    }
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

    const pathname = new URL(request.url).pathname;
    if (!hasMasterSecret(this.env) && !isProbePath(pathname)) {
      return missingMasterSecretResponse(request);
    }

    if (isAgentAccessPath(pathname)) {
      const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
      const { handleAgentAccessRequest } = await import("./agent-access/runtime");
      const response = await handleAgentAccessRequest(request, env, this.ctx);
      return applyBaselineSecurityHeaders(request, response, {
        frameProtection: "deny",
      });
    }

    const cachePolicy = getPublicApiCachePolicy(request);
    if (cachePolicy) {
      const cacheRequest = cachePolicy.canonicalUrl === request.url
        ? request
        : new Request(cachePolicy.canonicalUrl, request);
      return this.ctx.exports.PublicApi.fetch(cacheRequest);
    }

    const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
    return fetchApiApp(request, env, this.ctx);
  }

  // Queues: payment events, OTP, notifications, storefront cache purge
  async queue(batch: MessageBatch<Record<string, unknown>>) {
    if (isDatabaseMigrationFrozen(this.env) || !hasMasterSecret(this.env)) {
      batch.retryAll({
        delaySeconds: DATABASE_MIGRATION_RETRY_AFTER_SECONDS,
      });
      return;
    }

    const env = await composeApiRuntimeEnv(this.env);
    const { handleQueueBatch } = await import("./queue-consumer");
    return handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env, this.ctx);
  }

  // Cron: release orphaned reservations, archive stale incomplete online orders, and flush outboxes.
  async scheduled(controller: ScheduledController): Promise<void> {
    if (isDatabaseMigrationFrozen(this.env) || !hasMasterSecret(this.env)) return;

    const env = await composeApiRuntimeEnv(this.env);
    const { runScheduledMaintenance } = await import("./scheduled-maintenance");
    await runScheduledMaintenance(env, this.ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    try {
      const { purgeExpiredOAuthData } = await import("./agent-access/oauth");
      await purgeExpiredOAuthData(env);
    } catch {
      // OAuth protocol storage cleanup is retryable maintenance. It must not
      // hide successful commerce recovery work from this scheduled run.
    }
    try {
      const { purgeExpiredAgentArtifacts } = await import("./agent-access/artifact-delivery");
      await purgeExpiredAgentArtifacts(env);
    } catch {
      // Artifact expiry and object cleanup retry on the next scheduled run and
      // never hide successful commerce maintenance.
    }
    try {
      const { getDb } = await import("@scalius/database/client");
      const { expireAgentBrowserHandoffs } = await import("./agent-access/browser-handoffs");
      await expireAgentBrowserHandoffs(getDb(env));
    } catch {
      // Browser handoffs expire in five minutes and are one-use. Relational
      // cleanup is retryable and must not hide successful commerce work.
    }
  }
}
