// Server side of buyer downloads (Wave B design §3.4): the account list read,
// the Download form post (mint a ticket, 303 to it), the licence-key reveal and
// the ticket stream proxy. Every call goes to the API through the storefront's
// proxy transport (service binding in production).
//
// Credentials: the account session travels as the `cs_tok` cookie only; a
// guest order's receipt proof is read from its httpOnly cookie and sent only
// as the X-Receipt-Token header. A ticket is bound to the proof it was minted
// with, so the stream sends that same proof again and never the other one.
// Nothing here logs a proof, a ticket signature or a licence key.

import { resolveBackendTarget } from "@/lib/api/transport";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { sessionCookieOf } from "@/lib/account-inbox-server";
import {
  defaultDownloadReturnPath,
  downloadFlagForApi,
  isDigitalId,
  isDownloadTicketHref,
  readBuyerDigitalLines,
  safeDownloadReturnPath,
  withDownloadStatus,
  type BuyerDigitalLine,
  type DigitalAccess,
  type DownloadStatusFlag,
  type DownloadTicketParams,
} from "@/lib/account-downloads";

const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 10_000;
/** Until the API starts answering; the body then streams for as long as the file takes. */
const STREAM_HEADERS_TIMEOUT_MS = 20_000;
const MAX_FORM_BYTES = 8 * 1024;

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;

/** Stream response headers passed through from the API as they are. */
const STREAM_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Content-Range",
  "Accept-Ranges",
  "Content-Disposition",
  "X-Content-Type-Options",
  "Content-Security-Policy",
  "Referrer-Policy",
] as const;
const RANGE_PATTERN = /^bytes=\d{0,15}-\d{0,15}$/;

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "signed_out" | "no_access" | "unavailable" };

/** API headers proving the buyer for this access, or null when this browser has no such proof. */
export function digitalProofHeaders(request: Request, access: DigitalAccess): Headers | null {
  const headers = new Headers({ Accept: "application/json" });
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  if (access.kind === "receipt") {
    const proof = readOrderReceiptCookie(request.headers.get("cookie"), access.orderId);
    if (!proof) return null;
    headers.set("X-Receipt-Token", proof);
    return headers;
  }
  const session = sessionCookieOf(request);
  if (!session) return null;
  headers.set("Cookie", session);
  return headers;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/** API paths per access. Ids only; the proof is never part of a path or query. */
export function digitalApiPaths(access: DigitalAccess) {
  const base = access.kind === "account" ? "/api/v1/customer-auth" : `/api/v1/orders/receipt/${encode(access.orderId)}`;
  return {
    list: `${base}/downloads`,
    ticket: (entitlementId: string) => `${base}/downloads/${encode(entitlementId)}/ticket`,
    reveal: (keyId: string) => `${base}/licence-keys/${encode(keyId)}/reveal`,
  };
}

async function callApi(path: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const target = resolveBackendTarget(path);
  if (!target) return null;
  try {
    return await target.fetch(target.url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.warn("[downloads] API call failed:", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

async function envelopeData(response: Response): Promise<Record<string, unknown> | null> {
  const payload = await response.json().catch(() => null) as { success?: unknown; data?: unknown } | null;
  return payload && payload.success === true && payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : null;
}

async function errorCode(response: Response): Promise<string | null> {
  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const error = payload?.error;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : payload?.code;
  return typeof code === "string" ? code : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Everything the signed-in account's orders delivered, newest first. */
export async function readAccountDownloads(request: Request): Promise<ReadResult<BuyerDigitalLine[]>> {
  const headers = digitalProofHeaders(request, { kind: "account" });
  if (!headers) return { ok: false, reason: "signed_out" };
  const response = await callApi(digitalApiPaths({ kind: "account" }).list, { method: "GET", headers }, READ_TIMEOUT_MS);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    if (response?.status === 401) return { ok: false, reason: "signed_out" };
    return { ok: false, reason: "unavailable" };
  }
  const lines = readBuyerDigitalLines(await envelopeData(response));
  return lines ? { ok: true, data: lines } : { ok: false, reason: "unavailable" };
}

// ---------------------------------------------------------------------------
// Writes: a ticket and a key reveal
// ---------------------------------------------------------------------------

export type TicketResult = { ok: true; href: string } | { ok: false; flag: DownloadStatusFlag };

/** Counts one download and returns the storefront stream path to redirect to. */
export async function mintDownloadTicket(request: Request, access: DigitalAccess, entitlementId: string): Promise<TicketResult> {
  if (!isDigitalId(entitlementId)) return { ok: false, flag: "missing" };
  const headers = digitalProofHeaders(request, access);
  if (!headers) return { ok: false, flag: access.kind === "account" ? "signin" : "missing" };
  const response = await callApi(digitalApiPaths(access).ticket(entitlementId), { method: "POST", headers }, WRITE_TIMEOUT_MS);
  if (!response) return { ok: false, flag: "unavailable" };
  if (!response.ok) return { ok: false, flag: downloadFlagForApi(response.status, await errorCode(response), access) };
  const href = (await envelopeData(response))?.href;
  return isDownloadTicketHref(href, access, entitlementId) ? { ok: true, href } : { ok: false, flag: "unavailable" };
}

export type RevealResult = { ok: true; key: string; last4: string } | { ok: false; flag: DownloadStatusFlag };

/** One licence key's plaintext, for a no-store page only. */
export async function revealLicenceKey(request: Request, access: DigitalAccess, keyId: string): Promise<RevealResult> {
  if (!isDigitalId(keyId)) return { ok: false, flag: "missing" };
  const headers = digitalProofHeaders(request, access);
  if (!headers) return { ok: false, flag: access.kind === "account" ? "signin" : "missing" };
  const response = await callApi(digitalApiPaths(access).reveal(keyId), { method: "POST", headers }, WRITE_TIMEOUT_MS);
  if (!response) return { ok: false, flag: "unavailable" };
  if (!response.ok) return { ok: false, flag: downloadFlagForApi(response.status, await errorCode(response), access) };
  const data = await envelopeData(response);
  const key = data?.key;
  if (typeof key !== "string" || !key || data?.keyId !== keyId) return { ok: false, flag: "unavailable" };
  return { ok: true, key, last4: typeof data.last4 === "string" ? data.last4 : key.slice(-4) };
}

// ---------------------------------------------------------------------------
// Form posts
// ---------------------------------------------------------------------------

/** The posted fields of a small form (urlencoded or multipart), or null. */
export async function readSmallForm(request: Request): Promise<FormData | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/** A form's access: a valid `orderId` field means a receipt page, none means the account. Null for a bad id. */
export function formAccess(form: FormData | null): DigitalAccess | null {
  const orderId = form?.get("orderId");
  if (orderId === null || orderId === undefined || orderId === "") return { kind: "account" };
  return isDigitalId(orderId) ? { kind: "receipt", orderId } : null;
}

export function formReturnPath(form: FormData | null, access: DigitalAccess | null): string {
  return safeDownloadReturnPath(form?.get("returnTo")) ?? defaultDownloadReturnPath(access ?? { kind: "account" });
}

export function privateRedirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...PRIVATE_HEADERS } });
}

/**
 * The Download button's POST: mint a ticket with this browser's proof and 303
 * to it (the browser then downloads with the same cookie), or 303 back to the
 * page with only the outcome flag and the file's anchor.
 */
export async function handleDownloadTicketPost(request: Request): Promise<Response> {
  const form = await readSmallForm(request);
  const access = formAccess(form);
  const returnTo = formReturnPath(form, access);
  const entitlementId = form?.get("entitlementId");
  if (!form || !access || !isDigitalId(entitlementId)) {
    return privateRedirect(withDownloadStatus(returnTo, "missing", null));
  }
  const result = await mintDownloadTicket(request, access, entitlementId);
  return result.ok
    ? privateRedirect(result.href)
    : privateRedirect(withDownloadStatus(returnTo, result.flag, entitlementId));
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

function streamFailure(status: 404 | 503): Response {
  return new Response(status === 404 ? "Not found" : "Downloads are unavailable right now.", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS },
  });
}

/**
 * Streams one ticket's file through the storefront origin with the proof the
 * ticket was minted with. The buyer's Range is forwarded so a broken download
 * resumes; the body is passed through unbuffered (files reach 2 GB).
 */
export async function proxyDownloadStream(
  request: Request,
  access: DigitalAccess,
  params: DownloadTicketParams | null,
): Promise<Response> {
  if (!params) return streamFailure(404);
  const proof = digitalProofHeaders(request, access);
  if (!proof) return streamFailure(404);
  const headers = new Headers({ Accept: "application/octet-stream" });
  if (access.kind === "receipt") headers.set("X-Receipt-Token", proof.get("X-Receipt-Token")!);
  else headers.set("Cookie", proof.get("Cookie")!);
  const range = request.headers.get("range")?.trim();
  if (range && RANGE_PATTERN.test(range)) headers.set("Range", range);

  const target = resolveBackendTarget(
    `/api/v1/orders/downloads/${encode(params.entitlementId)}/${encode(params.exp)}/${encode(params.sig)}`,
  );
  if (!target) return streamFailure(503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_HEADERS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await target.fetch(target.url, { method: "GET", headers, signal: controller.signal });
  } catch (error) {
    console.warn("[downloads] stream failed:", error instanceof Error ? error.name : "unknown");
    return streamFailure(503);
  } finally {
    clearTimeout(timer);
  }

  const status = upstream.status;
  if (status !== 200 && status !== 206 && status !== 416) {
    await upstream.body?.cancel().catch(() => undefined);
    return streamFailure(status >= 500 ? 503 : 404);
  }
  const out = new Headers();
  for (const name of STREAM_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // Private and never sniffed or rendered here, whatever the API sent.
  out.set("Cache-Control", "private, no-store");
  out.set("X-Content-Type-Options", "nosniff");
  if (!out.has("Content-Security-Policy")) out.set("Content-Security-Policy", "sandbox");
  if (!out.has("Referrer-Policy")) out.set("Referrer-Policy", "no-referrer");
  if (status !== 416 && !out.get("Content-Disposition")?.toLowerCase().startsWith("attachment")) {
    await upstream.body?.cancel().catch(() => undefined);
    return streamFailure(404);
  }
  return new Response(status === 416 ? null : upstream.body, { status, headers: out });
}
