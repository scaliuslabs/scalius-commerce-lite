/**
 * The dashboard, served by this Worker.
 *
 * The dashboard is a static single-page app (apps/admin-v2 → `ASSETS`). It
 * keeps its own hostname: the Platform Dashboard URL. Hashed bundles under
 * `/assets/*` are answered by Cloudflare's asset layer without invoking the
 * Worker (`run_worker_first` in wrangler.jsonc); everything else on the
 * dashboard host arrives here:
 *
 *   <base>/api/auth/*          Better Auth + route-guard state (./auth.ts)
 *   <base>/api/scanner-token   scanner cookie exchange (./scanner-session.ts)
 *   <base>/api/realtime        staff WebSocket to the realtime hub (../realtime/connect.ts)
 *   <base>/api/v1/*            the normal API, with the base path removed
 *   <base>/<file.ext>          a static file below the base path
 *   <base>/<route>             the SPA shell (index.html)
 *
 * `<base>` is the runtime base path from the Dashboard URL ("" at a host
 * root). The shell carries it in a `<meta>` tag and on every root-relative
 * asset URL, so one build serves any prefix.
 */
import {
  dashboardBasePathFromUrl,
  isLoopbackUrl,
  stripDashboardBasePath,
} from "@scalius/shared/platform-config";
import {
  CAMERA_PERMISSIONS_POLICY,
  PERMISSIONS_POLICY,
  dashboardDocumentCsp,
} from "@scalius/shared/http-security";
import { bufferRequestBody, PayloadTooLargeError } from "@scalius/shared/request-body-limit";
import { apiNotFoundResponse } from "../runtime/not-found";
import { handleDashboardAuthRequest } from "./auth";
import { handleScannerSessionRequest } from "./scanner-session";

/** The dashboard's sign-in endpoints take small JSON forms (route-limits.ts BODY_LIMITS.form). */
export const DASHBOARD_AUTH_BODY_BYTES = 32 * 1024;

const STATIC_FILE_PATTERN = /\.[a-z0-9]{1,8}$/i;
const BASE_PATH_META = /<meta name="scalius-dashboard-base-path" content="[^"]*"\s*\/?>/;

/** A path this host does not serve: the API's one not-found answer. */
const notFound = apiNotFoundResponse;

/** A browser loading a page (a reload or a typed address), never a script, style or image fetch. */
function isPageLoad(request: Request): boolean {
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination) return destination === "document";
  return request.headers.get("Accept")?.includes("text/html") === true;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Points the built shell at `basePath`: meta tag plus root-relative src/href. */
export function applyBasePathToShell(html: string, basePath: string): string {
  if (!basePath) return html;
  return html
    .replace(BASE_PATH_META, `<meta name="scalius-dashboard-base-path" content="${basePath}">`)
    .replace(/(\s(?:src|href)=")\/(?!\/)/g, `$1${basePath}/`);
}

async function serveStatic(
  request: Request,
  env: Env,
  path: string,
  basePath: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return notFound();
  // `vite dev` serves the dashboard locally; wrangler.local.jsonc binds no assets.
  if (!env.ASSETS) return notFound();

  const url = new URL(request.url);
  if (STATIC_FILE_PATTERN.test(path)) {
    url.pathname = path;
    const asset = await env.ASSETS.fetch(new Request(url, { method, headers: request.headers }));
    // A route can end like a file name (an app's page, /admin/apps/scalius.noor): a page
    // load of a file that does not exist gets the shell. A missing chunk stays a 404.
    if (asset.status !== 404 || !isPageLoad(request)) return asset;
  }

  url.pathname = "/index.html";
  url.search = "";
  const shell = await env.ASSETS.fetch(new Request(url));
  if (!shell.ok) return shell;
  const html = applyBasePathToShell(await shell.text(), basePath);
  return new Response(method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The shell names the current hashed bundles; never serve a stale one.
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Security-Policy": await dashboardDocumentCsp(html, {
        documentOrigin: url.origin,
        storefrontUrl: env.PLATFORM_CONFIG?.storefrontUrl,
        mediaUrl: env.PLATFORM_CONFIG?.mediaUrl,
      }),
    },
  });
}

/** The scanner's route below the base path: the one document that may use the camera. */
function isScannerPath(path: string): boolean {
  return path === "/scanner" || path.startsWith("/scanner/");
}

/**
 * The Permissions-Policy of a dashboard response. The dashboard is one
 * document per page load, and a document keeps the policy it loaded with, so
 * the camera is granted to the document a scanner link opens (`/scanner`,
 * the only screen that mounts the camera scanner) and to no other.
 */
export function dashboardPermissionsPolicy(request: Request, env: Env): string {
  const path = stripDashboardBasePath(
    new URL(request.url).pathname,
    dashboardBasePathFromUrl(env.PLATFORM_CONFIG?.dashboardUrl),
  );
  return path !== null && isScannerPath(path) ? CAMERA_PERMISSIONS_POLICY : PERMISSIONS_POLICY;
}

/**
 * Answers a request that is not a root `/api/v1/*` API call. Returns the
 * rewritten request when it is an API call below the dashboard base path.
 */
export async function routeDashboardRequest(
  request: Request,
  env: Env,
): Promise<Response | Request> {
  const url = new URL(request.url);
  const dashboardUrl = env.PLATFORM_CONFIG?.dashboardUrl;
  const dashboardOrigin = originOf(dashboardUrl);
  // Host routing: once a Dashboard URL is set, only its host serves the
  // dashboard (the API host keeps answering 404 outside /api/v1). Loopback
  // requests are `pnpm dev`, where Vite proxies from another port.
  if (dashboardOrigin && dashboardOrigin !== url.origin && !isLoopbackUrl(url.origin)) {
    return notFound();
  }

  const basePath = dashboardBasePathFromUrl(dashboardUrl);
  const path = stripDashboardBasePath(url.pathname, basePath);
  if (path === null) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return notFound();
    return new Response(null, {
      status: 308,
      headers: {
        Location: new URL(`${basePath}${url.pathname}${url.search}`, url.origin).toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  if (path.startsWith("/api/v1/")) {
    const target = new URL(url);
    target.pathname = path;
    return new Request(target, request);
  }
  if (path === "/api/auth" || path.startsWith("/api/auth/") || path === "/api/scanner-token") {
    // Sign-in, codes, passkeys and the scanner token take small JSON forms:
    // bounded before Better Auth or the handler parses them.
    let bounded: Request;
    try {
      bounded = await bufferRequestBody(request, DASHBOARD_AUTH_BODY_BYTES);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      return Response.json(
        { success: false, error: { code: "payload_too_large", message: error.message, details: { maxBytes: error.maxBytes } } },
        { status: 413, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return path === "/api/scanner-token"
      ? handleScannerSessionRequest(bounded, env)
      : handleDashboardAuthRequest(bounded, env, path, basePath);
  }
  if (path === "/api/realtime") {
    const { handleRealtimeConnect } = await import("../realtime/connect");
    return handleRealtimeConnect(request, env);
  }
  if (path.startsWith("/api/")) return notFound();
  return serveStatic(request, env, path, basePath);
}
