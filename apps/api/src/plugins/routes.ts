// Plugin routes (docs/platform/PLUGINS.md, "Extension points" 4): every HTTP
// request a plugin answers enters here and goes through `PluginHost.invokeRoute`.
//
//   /api/v1/plugins/<id>/admin/<route>[/<sub path>]     dashboard session, apps.view (+ apps.use to change)
//   /api/v1/plugins/<id>/public/<route>[/<sub path>]    unauthenticated, rate-limited per client
//   /api/v1/plugins/<id>/webhooks/<name>[/<sub path>]   provider callbacks, raw body preserved
//
// The storefront mounts the public routes at `/apps/<id>/*` (its proxy sets
// `x-scalius-app-proxy`), for plugins whose manifest asks for the proxy. A
// proxied request may carry the store's own customer session cookie, which
// the storefront forwards for this alone: the platform resolves it and the
// plugin gets `request.customer = { id }`, never the cookie.
//
// The platform owns the edges: only active plugins answer; only declared
// routes and methods; bodies are capped; request headers are filtered (no
// cookie or credential ever reaches a plugin, public and admin routes get a
// small allowlist); responses are validated, always JSON, never set cookies
// and carry a deny-all CSP. Caching is conservative: admin responses are
// private and never stored; a public or webhook response may opt in only
// with exactly `public, max-age=N` (N ≤ 300), else it is `no-store`.

import { Hono, type Context } from "hono";
import type { Database } from "@scalius/database/client";
import { getActivePluginInstallation, maskPluginLogText, type PluginInstallation } from "@scalius/core/modules/plugins";
import { PLUGIN_ID_PATTERN, PLUGIN_SCOPES, PLUGIN_URL_NAME_PATTERN } from "@scalius/shared/plugins";
import type { PluginRouteRequest } from "@scalius/plugin-sdk";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { privateNoStore } from "../middleware/private-no-store";
import { getTrustedClientIp } from "../utils/client-ip";
import { isWithinRateLimit } from "../utils/rate-limit";
import type { PluginHostOptions, PluginInvocationFailure } from "./host";

export type PluginRouteSurface = "admin" | "public" | "webhooks";

/** Set by the storefront's `/apps/<id>/*` proxy (never forwarded from a browser). */
export const PLUGIN_APP_PROXY_HEADER = "x-scalius-app-proxy";
export const PLUGIN_ROUTE_BODY_LIMITS: Readonly<Record<PluginRouteSurface, number>> = {
  admin: 1024 * 1024,
  public: 256 * 1024,
  webhooks: 1024 * 1024,
};
export const PLUGIN_PUBLIC_CACHE_MAX_AGE = 300;
const MAX_SUBPATH_LENGTH = 512;
const MAX_QUERY_ENTRIES = 50;
const MAX_QUERY_VALUE = 2048;
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE = 4096;
/** Request headers admin and public routes see; everything else is dropped. */
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "user-agent",
  "x-requested-with",
]);
/** Never passed to a plugin, on any surface: credentials, network and platform headers. */
const DENIED_REQUEST_HEADERS = /^(?:cookie|authorization|proxy-authorization|host|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|forwarded|via|x-real-ip|true-client-ip|cf-.*|x-forwarded-.*|x-scalius-.*|x-api-token|x-receipt-token)$/i;
const SAFE_PUBLIC_CACHE = /^public,\s*max-age=(\d{1,6})$/i;

interface ParsedTarget {
  surface: PluginRouteSurface;
  pluginId: string;
  name: string;
  subpath: string;
}

/** `/api/v1/plugins/<id>/<surface>/<name>[/<sub path>]`, validated; null when it is not one. */
export function parsePluginRoutePath(pathname: string): ParsedTarget | null {
  const match = /^\/api\/v1\/plugins\/([^/]+)\/(admin|public|webhooks)\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const [, pluginId, surface, name, rest] = match;
  if (!PLUGIN_ID_PATTERN.test(pluginId!) || !PLUGIN_URL_NAME_PATTERN.test(name!)) return null;
  const subpath = (rest ?? "").replace(/^\/+/, "");
  if (subpath.length > MAX_SUBPATH_LENGTH) return null;
  // Decoded segments must stay segments: no dot segments or encoded separators.
  for (const segment of subpath.split("/")) {
    if (segment === "." || segment === "..") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === ".." || [...decoded].some((character) => character.charCodeAt(0) < 0x20)) return null;
  }
  return { surface: surface as PluginRouteSurface, pluginId: pluginId!, name: name!, subpath };
}

/** The methods a declared route answers, or null when the plugin does not declare it. */
export function declaredPluginRouteMethods(installation: PluginInstallation, surface: PluginRouteSurface, name: string): readonly string[] | null {
  const route = installation.manifest.routes[surface].find((entry) => entry.name === name);
  return route ? route.methods : null;
}

/** The headers a plugin sees on this surface (lowercase names). */
export function filterPluginRequestHeaders(headers: Headers, surface: PluginRouteSurface): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (DENIED_REQUEST_HEADERS.test(name)) continue;
    if (surface !== "webhooks" && !ALLOWED_REQUEST_HEADERS.has(name)) continue;
    if (value.length > MAX_HEADER_VALUE || count >= MAX_HEADERS) continue;
    result[name] = value;
    count += 1;
  }
  return result;
}

function queryOf(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of url.searchParams) {
    if (count >= MAX_QUERY_ENTRIES) break;
    if (Object.prototype.hasOwnProperty.call(query, key) || key.length > 128) continue;
    query[key] = value.slice(0, MAX_QUERY_VALUE);
    count += 1;
  }
  return query;
}

class BodyTooLargeError extends Error {}

/** The request body as text, refusing anything over `limit` bytes before reading it all. */
async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return null;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** JSON bodies parse; form bodies become an object of their last values; anything else is null (webhooks keep `rawBody`). */
function parseBody(raw: string | null, contentType: string): { ok: true; body: unknown } | { ok: false } {
  if (raw === null) return { ok: true, body: null };
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return { ok: true, body: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false };
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    const form: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) form[key] = value;
    return { ok: true, body: form };
  }
  return { ok: true, body: null };
}

function jsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      ...headers,
    },
  });
}

const FAILURE_STATUS: Record<PluginInvocationFailure, { status: number; code: string; message: string }> = {
  inactive: { status: 404, code: "NOT_FOUND", message: "This app is not available." },
  outdated: { status: 503, code: "APP_UPDATING", message: "The app was just updated. Try again in a few seconds." },
  unavailable: { status: 503, code: "APP_UNAVAILABLE", message: "The app cannot run on this store's plan." },
  load_failed: { status: 502, code: "APP_FAILED", message: "The app could not be loaded." },
  settings_unreadable: { status: 503, code: "APP_UNAVAILABLE", message: "The app's settings cannot be read. Save them again in the dashboard." },
  timeout: { status: 504, code: "APP_TIMEOUT", message: "The app took too long to answer." },
  error: { status: 502, code: "APP_FAILED", message: "The app could not answer." },
  invalid: { status: 502, code: "APP_FAILED", message: "The app gave an invalid answer." },
  limited: { status: 429, code: "APP_BUSY", message: "The app is busy. Try again in a minute." },
  migration_failed: { status: 502, code: "APP_FAILED", message: "The app could not update its data." },
};

/** `Cache-Control` of a plugin response on a surface: admin never stored; others only an exact, short public max-age. */
export function pluginResponseCacheControl(surface: PluginRouteSurface, requested: string | undefined): string {
  if (surface === "admin") return "private, no-store";
  const match = requested ? SAFE_PUBLIC_CACHE.exec(requested.trim()) : null;
  if (match && Number(match[1]) <= PLUGIN_PUBLIC_CACHE_MAX_AGE) return `public, max-age=${Number(match[1])}`;
  return "no-store";
}

/**
 * The signed-in buyer of a request the storefront proxied, from the store's
 * own session cookie, which the storefront forwards for this purpose alone
 * (lib/app-proxy.ts). The app gets the customer id; it never sees the cookie
 * (every route's headers drop it). Null for guests and expired sessions.
 */
async function proxiedCustomer(c: Context<{ Bindings: Env }>, db: Database): Promise<{ id: string } | null> {
  const { getCustomerBySession, getSessionCookie } = await import("@scalius/core/modules/customers");
  const token = getSessionCookie(c.req.header("cookie") ?? null);
  if (!token) return null;
  try {
    const { getCustomerSessionHashKey } = await import("../utils/encryption-key");
    const session = await getCustomerBySession(db, token, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>));
    return session?.customerId ? { id: session.customerId } : null;
  } catch {
    return null;
  }
}

export interface PluginRouteDependencies {
  /** Test seam (the host's loader choice). */
  loaderFor?: PluginHostOptions["loaderFor"];
}

export async function handlePluginRoute(c: Context<{ Bindings: Env }>, deps: PluginRouteDependencies = {}): Promise<Response> {
  const url = new URL(c.req.url);
  const target = parsePluginRoutePath(url.pathname);
  if (!target) return jsonError(404, "NOT_FOUND", "Not found.");
  const db = c.get("db") as Database;
  const method = c.req.method.toUpperCase();

  const installation = await getActivePluginInstallation(db, target.pluginId);
  // Unknown and inactive apps look the same from outside.
  if (!installation?.grant) return jsonError(404, "NOT_FOUND", "This app is not available.");
  const methods = declaredPluginRouteMethods(installation, target.surface, target.name);
  if (!methods) return jsonError(404, "NOT_FOUND", "Not found.");
  if (!methods.includes(method)) {
    return jsonError(405, "METHOD_NOT_ALLOWED", `Use ${methods.join(", ")}.`, { Allow: methods.join(", ") });
  }
  if (target.surface === "admin") {
    const scope = installation.manifest.routes.admin.find((route) => route.name === target.name)?.scope;
    // The app's approved grant cannot elevate the operator opening its UI:
    // a scope-gated route needs the scope granted and its staff permission.
    // This runs before reading the body or invoking either plugin loader.
    const staffPermissions = c.get("adminPermissions") as ReadonlySet<string> | undefined;
    if (scope && (!installation.grant.scopes.includes(scope) || !staffPermissions?.has(PLUGIN_SCOPES[scope].staff))) {
      return jsonError(403, "FORBIDDEN", "You do not have permission to perform this action.");
    }
  }
  if (target.surface !== "admin") {
    if (!installation.grant.publicRoutes) return jsonError(404, "NOT_FOUND", "This app is not available.");
    if (c.req.header(PLUGIN_APP_PROXY_HEADER) && !installation.manifest.storefront.proxy) {
      return jsonError(404, "NOT_FOUND", "Not found.");
    }
    const client = getTrustedClientIp(c);
    const purpose = target.surface === "public" ? `plugin-public:${target.pluginId}` : `plugin-webhook:${target.pluginId}:${target.name}`;
    if (!(await isWithinRateLimit(c.env, "RL_STANDARD", purpose, client))) {
      return jsonError(429, "RATE_LIMIT", "Too many requests. Try again in a minute.", { "Retry-After": "60" });
    }
  }

  let raw: string | null;
  try {
    raw = await readBoundedBody(c.req.raw, PLUGIN_ROUTE_BODY_LIMITS[target.surface]);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return jsonError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    throw error;
  }
  const parsed = parseBody(raw, c.req.header("content-type") ?? "");
  if (!parsed.ok) return jsonError(400, "INVALID_JSON", "The request body is not valid JSON.");
  const user = target.surface === "admin" ? (c.get("user") as { id?: string } | undefined) : undefined;
  const proxied = target.surface === "public" && Boolean(c.req.header(PLUGIN_APP_PROXY_HEADER)) && installation.manifest.storefront.proxy;
  const request: PluginRouteRequest = {
    method,
    subpath: target.subpath,
    query: queryOf(url),
    headers: filterPluginRequestHeaders(c.req.raw.headers, target.surface),
    body: parsed.body,
    rawBody: target.surface === "webhooks" ? raw ?? "" : null,
    staffId: user?.id ?? null,
    customer: proxied ? await proxiedCustomer(c, db) : null,
  };

  const { PluginHost } = await import("./host");
  const host = new PluginHost({ env: c.env, ctx: c.executionCtx as unknown as ExecutionContext, db, ...(deps.loaderFor ? { loaderFor: deps.loaderFor } : {}) });
  const outcome = await host.invokeRoute(installation, target.surface, target.name, request, user?.id ? { operator: { userId: user.id } } : {});
  if (!outcome.ok || !outcome.value) {
    const failure = FAILURE_STATUS[outcome.failure ?? "error"];
    // Staff see the app's own reason (masked like its log); buyers never do.
    const message = target.surface === "admin" && outcome.error ? maskPluginLogText(outcome.error).slice(0, 300) : failure.message;
    return jsonError(failure.status, failure.code, message, outcome.failure === "outdated" ? { "Retry-After": "5" } : {});
  }

  const { status, headers: pluginHeaders, body } = outcome.value;
  const headers = new Headers();
  let requestedCache: string | undefined;
  for (const [name, value] of Object.entries(pluginHeaders)) {
    const lower = name.toLowerCase();
    if (lower === "content-type") continue; // always JSON
    if (lower === "location" || lower === "refresh") continue; // never an open redirect from the store's hosts
    if (lower === "cache-control") {
      requestedCache = value;
      continue;
    }
    headers.set(name, value);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", pluginResponseCacheControl(target.surface, requestedCache));
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  const empty = status === 204 || status === 205 || status === 304 || method === "HEAD";
  return new Response(empty ? null : JSON.stringify(body ?? null), { status, headers });
}

/** The plugin route family: one catch-all per surface; the dashboard surface is behind the admin stack. */
export function createPluginRoutes(deps: PluginRouteDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/plugins/:pluginId/admin/*", privateNoStore);
  app.use("/plugins/:pluginId/admin/*", dashboardOriginGuardMiddleware);
  app.use("/plugins/:pluginId/admin/*", adminAuthMiddleware);
  app.all("/plugins/*", (c) => handlePluginRoute(c, deps));
  return app;
}
