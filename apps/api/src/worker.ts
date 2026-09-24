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
  RUNTIME_SECRET_PURPOSES,
  deriveRuntimeSecret,
  describeMissingMasterSecret,
  readMasterSecret,
} from "@scalius/shared/runtime-secrets";
import {
  FRONT_PROXY_SIGNATURE_HEADER,
  applyTrustedFrontProxy,
} from "@scalius/shared/trusted-front-proxy";
import {
  CACHE_GENERATION_HEADER,
  normalizeCacheGeneration,
} from "@scalius/shared/cache-generation";
import {
  getPublicApiCachePolicy,
  isCacheLayerServerError,
  logCacheLayerFallback,
  withoutCacheGeneration,
} from "./public-cache-policy";
import { publicReadCacheKey, renderPublicRead } from "./public-read";
import { readCacheGeneration } from "./utils/cache-generation";
import { isAgentAccessPath } from "./agent-access/paths";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";
import { composeApiRuntimeEnv, hasMasterSecret } from "./runtime/runtime-env";

export type { AppType } from "./app";

const PROBE_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/health/",
  "/api/v1/readyz",
  "/api/v1/readyz/",
  "/api/v1/meta",
  "/api/v1/meta/",
]);

function isProbePath(pathname: string): boolean {
  return PROBE_PATHS.has(pathname);
}

function isApiV1Path(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/**
 * Honours a signed front proxy's forwarded host, proto, and client IP. The
 * signature key is derived from the master secret only when the header is
 * present; unsigned or invalid headers leave the request untouched. The header
 * is removed afterwards so the public cache entrypoint does not re-verify it.
 */
async function resolveFrontProxy(request: Request, env: Env): Promise<Request> {
  if (!request.headers.has(FRONT_PROXY_SIGNATURE_HEADER)) return request;
  const master = readMasterSecret(env);
  const secret = master
    ? await deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET)
    : null;
  const resolved = (await applyTrustedFrontProxy(request, secret)).request;
  const stripped = new Request(resolved);
  stripped.headers.delete(FRONT_PROXY_SIGNATURE_HEADER);
  return stripped;
}

/**
 * Without the master secret no session or token auth can be verified.
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

/**
 * Workers Cache entrypoint for anonymous public reads. The request URL carries
 * the cache generation, so the cache key changes on every buyer-visible write;
 * the generation is removed before the application sees the request.
 */
export class PublicApi extends WorkerEntrypoint<Env> {
  async fetch(incoming: Request): Promise<Response> {
    const request = withoutCacheGeneration(await resolveFrontProxy(incoming, this.env));
    if (!getPublicApiCachePolicy(request)) {
      return new Response("Request is not eligible for public caching", {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    if (!hasMasterSecret(this.env)) return missingMasterSecretResponse(request);
    const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
    return renderPublicRead(request, env, this.ctx);
  }
}

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(incoming: Request) {
    let request = await resolveFrontProxy(incoming, this.env);
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

    // Everything outside /api/v1 is the dashboard: its SPA shell, Better Auth,
    // and API calls below a dashboard base path (src/dashboard/surface.ts).
    if (!isApiV1Path(pathname)) {
      const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
      const { routeDashboardRequest } = await import("./dashboard/surface");
      const routed = await routeDashboardRequest(request, env);
      if (routed instanceof Response) {
        return applyBaselineSecurityHeaders(request, routed, { frameProtection: "deny" });
      }
      request = routed;
    }

    if (getPublicApiCachePolicy(request)) {
      // A storefront render pins its API reads to its own page generation.
      // Generations are unguessable, so a caller-supplied value can only
      // select an entry that already exists or render a fresh one.
      const generation =
        normalizeCacheGeneration(request.headers.get(CACHE_GENERATION_HEADER))
        ?? await readCacheGeneration(this.env, this.ctx);
      const cacheKey = publicReadCacheKey(request, generation);
      if (cacheKey) {
        const cached = await this.ctx.exports.PublicApi.fetch(new Request(cacheKey, request));
        // The cache is a hint: a server error from the cache layer itself (a
        // stuck entry answers an empty platform 500) is rendered directly.
        if (!isCacheLayerServerError(cached)) return cached;
        await cached.body?.cancel();
        logCacheLayerFallback(request.url, request, cached.status);
      }
    }

    const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
    return fetchApiApp(request, env, this.ctx);
  }

  // Queues: payment events, OTP, notifications
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
