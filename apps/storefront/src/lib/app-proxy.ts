// The storefront app proxy (docs/platform/PLUGINS.md, "Extension points" 4):
// `/apps/<plugin id>/<route>[/<sub path>]` on the store's own origin forwards
// to the plugin's public route `/api/v1/plugins/<id>/public/<route>/...`
// through the API service binding. The API answers only for active plugins
// whose manifest asks for the proxy (`x-scalius-app-proxy`), so an app's
// widgets and forms can call it same-origin.
//
// Nothing private crosses: no cookie, no credential, no session; only a small
// allowlist of request headers plus the client IP for the API's rate limit.
// The response keeps the API's caching decision (no-store unless the app
// opted into a short public max-age) and never sets a cookie. Bodies are
// capped before they are forwarded.

import { resolveBackendTarget, type BackendTarget } from "@/lib/api/transport";

/** `vendor.name` (the platform's plugin id pattern). */
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const ROUTE_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "user-agent", "x-requested-with"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "vary", "allow", "retry-after", "content-security-policy"];
export const APP_PROXY_MAX_BODY_BYTES = 256 * 1024;
const APP_PROXY_TIMEOUT_MS = 35_000;
const MAX_PATH_LENGTH = 600;

function plain(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, error: { code: status === 404 ? "NOT_FOUND" : "APP_PROXY", message } }), {
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
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}
