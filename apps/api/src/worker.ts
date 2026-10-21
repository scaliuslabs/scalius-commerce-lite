// apps/api/src/worker.ts
// First import: zod 4 gives `.openapi()` only to schemas created after this
// extension runs, and route families load lazily in any order.
import "@hono/zod-openapi";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import {
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
import { cacheFrontierEndpoint, serveCacheFrontierCheck, serveCacheFrontierDelta } from "./cache-frontier";
import { isAgentAccessPath } from "./agent-access/paths";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";
import { composeApiRuntimeEnv, hasMasterSecret } from "./runtime/runtime-env";

export type { AppType } from "./app";
// The plugin bridge entrypoint: sandboxed plugins reach the platform only
// through `ctx.exports.PluginBridge` (plugins/loaders/sandbox.ts). Its methods
// load the bridge lazily, so this export costs no startup work.
export { PluginBridge } from "./plugins/bridge-entrypoint";
// The store's realtime hub (Durable Object, docs/platform/REALTIME.md). The
// class imports only the wire contract, so this export costs no startup work.
export { RealtimeHub } from "./realtime/hub";

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
      code: "runtime_secret_missing",
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

    // The storefront's change frontier: a quiet store's page hit waits on
    // this call, so it skips the Platform settings, the route families and
    // the middleware chain (one key check, one statement).
    const frontierEndpoint = cacheFrontierEndpoint(request.method, pathname);
    if (frontierEndpoint) {
      const { getDb } = await import("@scalius/database/client");
      const db = () => getDb(this.env);
      const response = await (frontierEndpoint === "delta"
        ? serveCacheFrontierDelta(request, this.env, db)
        : serveCacheFrontierCheck(request, this.env, db)
      ).catch((error: unknown) => {
        console.error("[CacheFrontier] read failed", error instanceof Error ? error.name : "unknown");
        return Response.json({ success: false, error: "Cache proof unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
      });
      return applyBaselineSecurityHeaders(request, response, { frameProtection: "deny" });
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
      // Validating a cached entry needs only the bindings and the Worker
      // version, so the Platform settings are read (and secrets derived) only
      // when a part has to render.
      const requestUrl = request.url;
      let composed: Promise<Env> | undefined;
      const runtimeEnv = () => (composed ??= composeApiRuntimeEnv(this.env, { requestUrl }));
      const { getDb } = await import("@scalius/database/client");
      const reader = createPublicPartReader({
        mode: "strict",
        env: this.env,
        cache: typeof caches === "undefined" ? null : caches.default,
        db: () => getDb(this.env),
        render: async (part) => renderPublicRead(part, await runtimeEnv(), this.ctx),
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
          { success: false, error: { code: "public_read_unavailable", message: "This content is temporarily unavailable. Please try again." } },
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

  // Cron (every minute): background drains and the sweep rotation (scheduled/slices.ts).
  async scheduled(controller: ScheduledController): Promise<void> {
    if (isDatabaseMigrationFrozen(this.env) || !hasMasterSecret(this.env)) return;

    const env = await composeApiRuntimeEnv(this.env);
    const { runScheduledMaintenance } = await import("./scheduled-maintenance");
    await runScheduledMaintenance(env, this.ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
  }
}
