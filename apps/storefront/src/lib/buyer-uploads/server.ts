/**
 * The same-origin side of buyer uploads (pages/api/uploads/**): the upload
 * control sends a file here and the storefront passes it, unread, to the API
 * (`/api/v1/orders/uploads`), which types it from its bytes, keeps it private
 * and rate limits by the buyer's address. Only the buyer's own page may call
 * it (a cross-site form or script is refused). Nothing here reads, stores or
 * logs a file, its name or its id.
 */
import { BUYER_UPLOAD_DECLARATION_LIMITS, BUYER_UPLOAD_ID_PATTERN } from "@scalius/shared/buyer-upload-value";
import { resolveBackendTarget } from "@/lib/api/transport";
import { readBoundedBytes } from "@/lib/bounded-body";

const UPLOAD_TIMEOUT_MS = 120_000;
const REMOVE_TIMEOUT_MS = 10_000;
/** The largest file any plan takes, and the multipart framing around it. */
export const BUYER_UPLOAD_MAX_BODY_BYTES = BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes + 64 * 1024;

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

function answer(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers: HEADERS });
}

/** Whether the request comes from another site (its Origin, or the browser's own fetch metadata, says so). */
export function crossSiteUpload(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function apiHeaders(request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ Accept: "application/json", ...extra });
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("cf-connecting-ip", ip);
  return headers;
}

async function relay(response: Response | null): Promise<Response> {
  if (!response) return answer(503, "upload_unavailable", "Uploads are unavailable right now. Try again.");
  const body = await response.text();
  return new Response(body, { status: response.status, headers: HEADERS });
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const target = resolveBackendTarget(path);
  if (!target) return null;
  try {
    return await target.fetch(target.url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.warn("[buyer-uploads] API call failed:", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

/** POST /api/uploads: one file, passed through as the buyer's browser sent it. */
export async function proxyBuyerUpload(request: Request): Promise<Response> {
  if (crossSiteUpload(request)) return answer(403, "forbidden", "Uploads come from the store's own pages.");
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return answer(400, "validation_error", "Upload one file as multipart form data.");
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return answer(411, "validation_error", "Upload one file as multipart form data.");
  if (declared > BUYER_UPLOAD_MAX_BODY_BYTES) return answer(413, "upload_too_large", "This file is too large.");
  const read = await readBoundedBytes(request, BUYER_UPLOAD_MAX_BODY_BYTES);
  if (!read.ok) return read.reason === "too_large" ? answer(413, "upload_too_large", "This file is too large.") : answer(400, "validation_error", "Upload one file as multipart form data.");
  const body = read.value;
  return relay(await call("/api/v1/orders/uploads", {
    method: "POST",
    headers: apiHeaders(request, { "Content-Type": type }),
    body,
  }, UPLOAD_TIMEOUT_MS));
}

/** DELETE /api/uploads/<id>: the buyer takes back a file no order holds yet. */
export async function proxyBuyerUploadRemove(request: Request, id: string | undefined): Promise<Response> {
  if (crossSiteUpload(request)) return answer(403, "forbidden", "Uploads come from the store's own pages.");
  if (!id || !BUYER_UPLOAD_ID_PATTERN.test(id)) return answer(404, "not_found", "Upload not found");
  return relay(await call(`/api/v1/orders/uploads/${id}`, { method: "DELETE", headers: apiHeaders(request) }, REMOVE_TIMEOUT_MS));
}
