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
import { handleDashboardAuthRequest } from "./auth";
import { handleScannerSessionRequest } from "./scanner-session";

const STATIC_FILE_PATTERN = /\.[a-z0-9]{1,8}$/i;
const BASE_PATH_META = /<meta name="scalius-dashboard-base-path" content="[^"]*"\s*\/?>/;

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
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
    return env.ASSETS.fetch(new Request(url, { method, headers: request.headers }));
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
    },
  });
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
  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return handleDashboardAuthRequest(request, env, path, basePath);
  }
  if (path === "/api/scanner-token") return handleScannerSessionRequest(request, env);
  if (path.startsWith("/api/")) return notFound();
  return serveStatic(request, env, path, basePath);
}
