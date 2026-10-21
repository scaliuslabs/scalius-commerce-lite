// The storefront app proxy (docs/platform/PLUGINS.md, "Extension points" 4):
// `/apps/<plugin id>/<route>[/<sub path>]` on the store's own origin forwards
// to the plugin's public route `/api/v1/plugins/<id>/public/<route>/...`
// through the API service binding. The API answers only for active plugins
// whose manifest asks for the proxy (`x-scalius-app-proxy`), so an app's
// widgets and forms can call it same-origin.
//
// What crosses: a small allowlist of request headers, the client IP for the
// API's rate limit, and, so the API can tell the app who is signed in, the
// store's own session cookie (`cs_tok`) and no other cookie: for GET/HEAD
// always, for unsafe methods only from this store's own pages (Sec-Fetch-Site
// same-origin/none, or an Origin equal to the store's). The API resolves the
// buyer and gives the app only `request.customer = { id }`; the app never
// sees the cookie. No credential or other session crosses.
//
// The response keeps the API's caching decision (no-store unless the app
// opted into a short public max-age; private once a session was forwarded)
// and never sets a cookie. Bodies are capped before they are forwarded.
//
// A browser navigation (a GET asking for HTML, or a plain form post) that
// the app answers with `{ page }` is drawn inside the store layout by
// pages/apps/[pluginId]/[...path].astro; `{ redirect }` becomes a 303 to a
// path on this store. Every other answer passes through unchanged.

import { resolveBackendTarget, type BackendTarget } from "@/lib/api/transport";
import { parsePluginPageOutput, type PluginPageOutput } from "@scalius/shared/plugins/storefront";
import { hasControlCharacter } from "@scalius/shared/plugins/html";

/** `vendor.name` (the platform's plugin id pattern). */
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const ROUTE_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "user-agent", "x-requested-with"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "vary", "allow", "retry-after", "content-security-policy"];
export const APP_PROXY_MAX_BODY_BYTES = 256 * 1024;
/** Largest app answer read to find a page or redirect; a larger one passes through unread. */
export const APP_PROXY_MAX_PAGE_ANSWER_BYTES = 512 * 1024;
const APP_PROXY_TIMEOUT_MS = 35_000;
const MAX_PATH_LENGTH = 600;
/** The store's customer session cookie: the only cookie the proxy forwards. */
const SESSION_COOKIE = "cs_tok";
/** A cookie value (RFC 6265 cookie-octets), bounded. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/;
const SAME_STORE_PATH = /^\/(?![/\\])[^\s\\]*$/;

function plain(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: { code: status === 404 ? "not_found" : "app_proxy", message } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** `<route>[/<sub path>]` → the API path, or null when the shape is wrong. */
export function appProxyApiPath(pluginId: string, path: string, search: string): string | null {
  if (!PLUGIN_ID.test(pluginId) || path.length > MAX_PATH_LENGTH) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || !ROUTE_NAME.test(segments[0]!)) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `/api/v1/plugins/${pluginId}/public/${segments.map((segment) => encodeURIComponent(decodeSafely(segment))).join("/")}${search}`;
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether a request comes from this store's own pages (for unsafe methods). */
export function isSameOriginAppRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  // A browser that states the site decides by it; same-site is another origin.
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/**
 * The `Cookie` header the proxy forwards: the store's session cookie alone,
 * as the browser sent it, or null (no session, a malformed value, or an
 * unsafe request from another site).
 */
export function appProxySessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  let value: string | null = null;
  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0 || chunk.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    value = chunk.slice(separator + 1).trim();
    break;
  }
  if (!value || !COOKIE_VALUE.test(value)) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !isSameOriginAppRequest(request)) return null;
  return `${SESSION_COOKIE}=${value}`;
}

async function boundedBody(request: Request): Promise<ArrayBuffer | null | "too_large"> {
  if (!request.body || request.method === "GET" || request.method === "HEAD") return null;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > APP_PROXY_MAX_BODY_BYTES) return "too_large";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > APP_PROXY_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function proxyAppRequest(
  request: Request,
  pluginId: string,
  path: string,
  resolveTarget: (apiPath: string) => BackendTarget | null = (apiPath) => resolveBackendTarget(apiPath),
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!METHODS.has(method)) return plain(405, "Method not allowed.", { Allow: [...METHODS].join(", ") });
  const apiPath = appProxyApiPath(pluginId, path, new URL(request.url).search);
  if (!apiPath) return plain(404, "Not found.");
  const target = resolveTarget(apiPath);
  if (!target) return plain(503, "The store cannot reach this app right now.");
  const body = await boundedBody(request);
  if (body === "too_large") return plain(413, "The request body is too large.");

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  const session = appProxySessionCookie(request);
  if (session) headers.set("cookie", session);
  headers.set("x-scalius-app-proxy", "1");

  let upstream: Response;
  try {
    upstream = await target.fetch(target.url, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(APP_PROXY_TIMEOUT_MS),
    });
  } catch {
    return plain(502, "The app could not be reached.");
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("cache-control")) responseHeaders.set("Cache-Control", "no-store");
  // An answer for a signed-in buyer is that buyer's alone.
  if (session) responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}

// ── Proxy pages ──────────────────────────────────────────────────────────

/**
 * A browser navigation: a GET asking for HTML, or a plain form post that
 * does not ask for JSON (the app forms enhancer asks for JSON).
 */
export function isAppPageNavigation(request: Request): boolean {
  const method = request.method.toUpperCase();
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (method === "GET") return accept.includes("text/html");
  if (method !== "POST") return false;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") && !accept.includes("application/json");
}

/** A path on this store for a redirect (never `//x`, `/\x` or another origin), or null. */
export function sameStoreRedirectPath(value: string, storeOrigin: string): string | null {
  if (!SAME_STORE_PATH.test(value) || hasControlCharacter(value)) return null;
  try {
    const url = new URL(value, storeOrigin);
    return url.origin === storeOrigin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

async function readTextAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type AppProxyPage = Extract<PluginPageOutput, { page: unknown }>["page"];

/** What the proxy answers: a page to draw inside the store layout, or a response as it is. */
export type AppProxyAnswer =
  | { kind: "page"; page: AppProxyPage; status: number }
  | { kind: "response"; response: Response };

/**
 * Reads a navigation's answer: an app's `{ page }` becomes a page to draw,
 * `{ redirect }` a 303 to that path on this store. Anything else (JSON,
 * errors, other requests) passes through byte for byte.
 */
export async function resolveAppProxyAnswer(request: Request, response: Response): Promise<AppProxyAnswer> {
  const asIs: AppProxyAnswer = { kind: "response", response };
  if (!isAppPageNavigation(request) || !response.body) return asIs;
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return asIs;
  const [probe, rest] = response.body.tee();
  const passThrough = (): AppProxyAnswer => ({
    kind: "response",
    response: new Response(rest, { status: response.status, statusText: response.statusText, headers: response.headers }),
  });
  const text = await readTextAtMost(probe, APP_PROXY_MAX_PAGE_ANSWER_BYTES);
  if (text === null) return passThrough();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return passThrough();
  }
  const output = parsePluginPageOutput(value);
  if (!output) return passThrough();
  if ("redirect" in output) {
    const location = sameStoreRedirectPath(output.redirect, new URL(request.url).origin);
    if (!location) return passThrough();
    void rest.cancel().catch(() => undefined);
    return {
      kind: "response",
      response: new Response(null, {
        status: 303,
        headers: { Location: location, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      }),
    };
  }
  void rest.cancel().catch(() => undefined);
  // The app's status stays (a "not found" page is a 404); a redirect status is not a page's.
  const status = response.status >= 300 && response.status < 400 ? 200 : response.status;
  return { kind: "page", page: output.page, status };
}

/**
 * Proxies one request and reads a navigation's answer (the proxy page's whole
 * job before it draws). Astro swaps a page's bodiless 404 or 500 for the
 * store's error page, so such an answer (a HEAD) keeps an empty body: the
 * API's answer passes through as it is.
 */
export async function answerAppProxyRequest(
  request: Request,
  pluginId: string,
  path: string,
  resolveTarget?: (apiPath: string) => BackendTarget | null,
): Promise<AppProxyAnswer> {
  const answer = await resolveAppProxyAnswer(request, await proxyAppRequest(request, pluginId, path, resolveTarget));
  if (answer.kind !== "response" || answer.response.body !== null) return answer;
  const { response } = answer;
  return response.status === 404 || response.status === 500
    ? { kind: "response", response: new Response("", { status: response.status, statusText: response.statusText, headers: response.headers }) }
    : answer;
}
