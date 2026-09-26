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
  getPublicApiCachePolicy,
} from "./public-cache-policy";
import { createPublicPartReader, renderPublicRead } from "./public-read";
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
      // Dependency-validated: a Workers Cache hit runs no code, so it could
      // not be validated; direct reads use the batch's reader instead.
      const env = await composeApiRuntimeEnv(this.env, { requestUrl: request.url });
      const { getDb } = await import("@scalius/database/client");
      const reader = createPublicPartReader({
        mode: "strict",
        env,
        cache: typeof caches === "undefined" ? null : caches.default,
        db: () => getDb(env),
        render: (part) => renderPublicRead(part, env, this.ctx),
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        maxConcurrentRenders: 1,
      });
      // HEAD shares GET's key, so always fill it with a full GET representation.
      // Client validators must not turn a cache fill into a bodyless 304.
      const readHeaders = new Headers(request.headers);
      readHeaders.delete("If-None-Match");
      readHeaders.delete("If-Modified-Since");
      const readRequest = new Request(request, { method: "GET", headers: readHeaders });
      const [result] = await reader.readParts([readRequest], null);
      if (result!.status === "rejected") {
        const unavailable = Response.json(
          { success: false, error: { code: "PUBLIC_READ_UNAVAILABLE", message: "This content is temporarily unavailable. Please try again." } },
          { status: 503, headers: { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "CDN-Cache-Control": "no-store" } },
        );
        return applyBaselineSecurityHeaders(request, request.method === "HEAD"
          ? new Response(null, { status: unavailable.status, headers: unavailable.headers })
          : unavailable, { frameProtection: "deny" });
      }
      const { response, cache } = result!.value;
      const headers = new Headers(response.headers);
      headers.set("X-Cache-Status", cache ? cache.status.toUpperCase() : "BYPASS");
      if (request.method === "HEAD") {
        void response.body?.cancel().catch(() => undefined);
        return new Response(null, { status: response.status, statusText: response.statusText, headers });
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
