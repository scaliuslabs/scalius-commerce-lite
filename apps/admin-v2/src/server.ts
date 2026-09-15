import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import { createDatabaseMigrationFreezeResponse } from "@scalius/shared/database-migration-freeze";
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
  dashboardBasePathFromUrl,
  prefixDashboardBasePath,
  stripDashboardBasePath,
} from "@scalius/shared/platform-config";
import { withPublicMediaUrl } from "@scalius/core/integrations/storage";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";
import {
  composeAdminRuntimeEnv,
  getRuntimeEnv,
  hasMasterSecret,
  runWithRuntimeEnv,
} from "./lib/runtime-env.server";

const HEALTH_PATHS = new Set(["/health", "/health/"]);
/** Build-time server-function base; TanStack Start only matches it at the root. */
const SERVER_FN_BASE = "/_serverFn/";
/** Build-time immutable asset directory (see vite.config.ts `assetsDir`). */
const IMMUTABLE_ASSET_PREFIX = "/assets/";
const STATIC_FILE_PATTERN = /\.[a-z0-9]{1,8}$/i;

/**
 * Asset URLs come from the Vite manifest at build time (`/assets/immutable/…`).
 * When the dashboard is served below a base path, prefix them per request so
 * the HTML, preloads, and stylesheets resolve through the same proxy. The
 * transform runs inside `runWithRuntimeEnv`, so the base path is the request's.
 */
const startHandler = createStartHandler({
  handler: defaultStreamHandler,
  transformAssets: {
    cache: false,
    transform: ({ url }) => prefixDashboardBasePath(currentBasePath(), url),
  },
});

function currentBasePath(): string {
  return dashboardBasePathFromUrl(getRuntimeEnv().PLATFORM_CONFIG?.dashboardUrl);
}

function isHealthPath(pathname: string): boolean {
  return HEALTH_PATHS.has(pathname);
}

/**
 * Without the master secret no admin session can be verified. Fail closed
 * for everything except the health probe, which keeps reporting liveness.
 */
function missingMasterSecretResponse(): Response {
  return Response.json(
    {
      success: false,
      error: describeMissingMasterSecret(),
      code: "RUNTIME_SECRET_MISSING",
    },
    { status: 503, headers: { "Cache-Control": "private, no-store" } },
  );
}

function outsideBasePathResponse(request: Request, basePath: string): Response {
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    const location = new URL(`${basePath}${url.pathname}${url.search}`, url.origin);
    return new Response(null, {
      status: 308,
      headers: { Location: location.toString(), "Cache-Control": "no-store" },
    });
  }
  return Response.json(
    {
      success: false,
      error: `The dashboard is served below ${basePath}.`,
      code: "DASHBOARD_BASE_PATH",
    },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** Honours a signed front proxy's forwarded host, proto, and client IP. */
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

function rewritePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url.toString(), request);
}

/**
 * Routes one request below the runtime base path. Static assets and
 * server-function calls are built at the host root, so they are translated
 * here; page and API routes keep their prefixed URL because the router owns
 * the same base path.
 *
 * `vite dev` is the one exception: its virtual module URLs (`/@id/...`) are
 * served by Vite itself, which this Worker cannot reach, and translating them
 * only makes the router redirect back into the prefix. Local development runs
 * the dashboard at the host root; the prefix is a deployment shape.
 */
async function handleWithBasePath(request: Request, env: Env, basePath: string): Promise<Response> {
  if (!basePath) return startHandler(request);

  const url = new URL(request.url);
  const inner = stripDashboardBasePath(url.pathname, basePath);
  if (inner === null) {
    return isHealthPath(url.pathname)
      ? startHandler(request)
      : outsideBasePathResponse(request, basePath);
  }

  if (inner.startsWith(SERVER_FN_BASE)) {
    return startHandler(rewritePath(request, inner));
  }

  const isRead = request.method === "GET" || request.method === "HEAD";
  const looksStatic = inner.startsWith(IMMUTABLE_ASSET_PREFIX) || STATIC_FILE_PATTERN.test(inner);
  if (isRead && looksStatic && env.ASSETS) {
    const asset = await env.ASSETS.fetch(rewritePath(request, inner));
    if (asset.status !== 404) return asset;
  }

  return startHandler(request);
}

export default {
  async fetch(incoming: Request, env: Env): Promise<Response> {
    const request = await resolveFrontProxy(incoming, env);
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const migrationResponse = createDatabaseMigrationFreezeResponse(
      request,
      env,
    );
    if (migrationResponse) {
      return applyBaselineSecurityHeaders(request, migrationResponse, {
        frameProtection: "deny",
      });
    }

    if (!hasMasterSecret(env) && !isHealthPath(new URL(request.url).pathname)) {
      return applyBaselineSecurityHeaders(request, missingMasterSecretResponse(), {
        frameProtection: "deny",
      });
    }

    const runtime = await composeAdminRuntimeEnv(env, request);
    const basePath = dashboardBasePathFromUrl(runtime.env.PLATFORM_CONFIG?.dashboardUrl);
    const response = await runWithRuntimeEnv(runtime.env, () =>
      withPublicMediaUrl(
        runtime.env.R2_PUBLIC_URL ?? "",
        () => handleWithBasePath(request, runtime.env, basePath),
      ),
    );
    return applyBaselineSecurityHeaders(
      request,
      applyAdminDocumentCachePolicy(request, response),
      { frameProtection: "deny" },
    );
  },
};
