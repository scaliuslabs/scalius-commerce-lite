// Server side of buyer reviews (Wave B §2.4, §7.1): the reads (the account's
// "To review" and "Your reviews", and a receipt's own reviews) and the form
// post that submits, edits or withdraws. Every call goes to the API through
// the storefront's proxy transport (the service binding in production).
//
// Credentials: the account session travels as the `cs_tok` cookie only; a
// guest order's receipt proof is read from its httpOnly cookie and sent only
// as the X-Receipt-Token header, never in a URL. Nothing here logs review
// text, a proof or a cookie: failures log an error name at most.
import { resolveBackendTarget } from "@/lib/api/transport";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { sessionCookieOf } from "@/lib/account-inbox-server";
import {
  defaultReviewReturnPath,
  isReviewId,
  readBuyerReviews,
  reviewFlagForApi,
  reviewNoticeText,
  safeReviewReturnPath,
  withReviewStatus,
  type BuyerReviews,
  type ReviewAccess,
  type ReviewFormCopy,
  type ReviewNoticeFlag,
} from "@/lib/account-reviews";
import { REVIEW_LIMITS } from "@scalius/shared/reviews";

const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 10_000;
/** Title, text and name at their limits in Bangla, percent-encoded, plus the ids. */
const MAX_FORM_BYTES = 96 * 1024;

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;

export type ReviewReadResult =
  | { ok: true; data: BuyerReviews }
  | { ok: false; reason: "signed_out" | "no_access" | "unavailable" };

/** API headers proving the buyer for this access, or null when this browser has no such proof. */
export function reviewProofHeaders(request: Request, access: ReviewAccess): Headers | null {
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

/** API paths per access. Ids only; the proof is never part of a path or query. */
export function reviewApiPaths(access: ReviewAccess) {
  const base = access.kind === "account"
    ? "/api/v1/customer-auth/reviews"
    : `/api/v1/orders/receipt/${encodeURIComponent(access.orderId)}/reviews`;
  return { list: base, review: (reviewId: string) => `${base}/${encodeURIComponent(reviewId)}` };
}

async function callApi(path: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const target = resolveBackendTarget(path);
  if (!target) return null;
  try {
    return await target.fetch(target.url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.warn("[reviews] API call failed:", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

interface ApiEnvelope {
  data: unknown;
  code: string | null;
  field: string | null;
  details: unknown;
}

async function readEnvelope(response: Response): Promise<ApiEnvelope> {
  const payload = await response.json().catch(() => null) as {
    success?: unknown;
    data?: unknown;
    error?: { code?: unknown; details?: unknown } | null;
  } | null;
  const error = payload?.error && typeof payload.error === "object" ? payload.error : null;
  const details = error?.details;
  const detailField = details && typeof details === "object" && !Array.isArray(details)
    ? (details as { field?: unknown }).field
    : Array.isArray(details) ? (details[0] as { field?: unknown } | undefined)?.field : undefined;
  return {
    data: payload?.success === true ? payload.data : null,
    code: typeof error?.code === "string" ? error.code : null,
    field: typeof detailField === "string" ? detailField : null,
    details,
  };
}

/** The review id a REVIEW_EXISTS answer names ("Edit your review"). */
function existingReviewId(envelope: ApiEnvelope): string | null {
  const candidate = envelope.details && typeof envelope.details === "object"
    ? (envelope.details as { reviewId?: unknown }).reviewId
    : undefined;
  return isReviewId(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The buyer's lines to review and reviews, for this access (account session or one receipt). */
export async function readBuyerReviewsForRequest(request: Request, access: ReviewAccess): Promise<ReviewReadResult> {
  const headers = reviewProofHeaders(request, access);
  if (!headers) return { ok: false, reason: access.kind === "account" ? "signed_out" : "no_access" };
  const response = await callApi(reviewApiPaths(access).list, { method: "GET", headers }, READ_TIMEOUT_MS);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    if (response?.status === 401) return { ok: false, reason: access.kind === "account" ? "signed_out" : "no_access" };
    if (response?.status === 403 || response?.status === 404) return { ok: false, reason: "no_access" };
    return { ok: false, reason: "unavailable" };
  }
  const reviews = readBuyerReviews((await readEnvelope(response)).data);
  return reviews ? { ok: true, data: reviews } : { ok: false, reason: "unavailable" };
}

// ---------------------------------------------------------------------------
// The form post
// ---------------------------------------------------------------------------

/** The posted fields of the review form (urlencoded or multipart), or null. */
export async function readReviewForm(request: Request): Promise<FormData | null> {
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
export function reviewFormAccess(form: FormData | null): ReviewAccess | null {
  const orderId = form?.get("orderId");
  if (orderId === null || orderId === undefined || orderId === "") return { kind: "account" };
  return isReviewId(orderId) ? { kind: "receipt", orderId } : null;
}

function text(form: FormData, name: string, max: number): string | null | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string") return null;
  // The API normalizes and checks lengths; this only keeps an oversized field out.
  return value.length > max * 2 ? value.slice(0, max * 2) : value;
}

export type ReviewPostOutcome = {
  flag: ReviewNoticeFlag;
  /** The order line the notice belongs to (anchor and notice placement). */
  lineId: string | null;
  /** With `exists`: the buyer's review of this product to edit. */
  reviewRef: string | null;
  returnTo: string;
  access: ReviewAccess;
};

/**
 * Submits, edits or withdraws from the posted form with this browser's proof
 * and says how it went. The API decides eligibility, limits and moderation;
 * this only maps its answer to a buyer-facing outcome.
 */
export async function submitReviewForm(request: Request, form: FormData | null): Promise<ReviewPostOutcome> {
  const access = reviewFormAccess(form) ?? { kind: "account" as const };
  const returnTo = safeReviewReturnPath(form?.get("returnTo")) ?? defaultReviewReturnPath(access);
  const lineId = isReviewId(form?.get("orderItemId")) ? form!.get("orderItemId") as string : null;
  const outcome = (flag: ReviewNoticeFlag, reviewRef: string | null = null): ReviewPostOutcome =>
    ({ flag, lineId, reviewRef, returnTo, access });
  if (!form || !reviewFormAccess(form)) return outcome("invalid");

  const intent = form.get("intent");
  const reviewId = form.get("reviewId");
  const version = Number(form.get("version"));
  const rawRating = form.get("rating");
  const rating = typeof rawRating === "string" && /^[1-5]$/.test(rawRating) ? Number(rawRating) : null;

  let path: string;
  let method: "POST" | "PATCH";
  let body: Record<string, unknown>;
  if (intent === "submit") {
    if (!lineId) return outcome("invalid");
    if (rating === null) return outcome("rating");
    const clientKey = form.get("clientKey");
    path = reviewApiPaths(access).list;
    method = "POST";
    body = {
      orderItemId: lineId,
      rating,
      title: text(form, "title", REVIEW_LIMITS.titleLength) || null,
      body: text(form, "body", REVIEW_LIMITS.bodyLength) || null,
      displayName: text(form, "displayName", REVIEW_LIMITS.displayNameLength) || null,
      ...(typeof clientKey === "string" && /^[A-Za-z0-9-]{8,64}$/.test(clientKey) ? { clientKey } : {}),
    };
  } else if ((intent === "edit" || intent === "withdraw") && isReviewId(reviewId) && Number.isInteger(version) && version > 0) {
    path = reviewApiPaths(access).review(reviewId);
    method = "PATCH";
    if (intent === "withdraw") {
      body = { version, withdraw: true };
    } else {
      if (rating === null) return outcome("rating");
      body = {
        version,
        rating,
        title: text(form, "title", REVIEW_LIMITS.titleLength) || null,
        body: text(form, "body", REVIEW_LIMITS.bodyLength) || null,
        displayName: text(form, "displayName", REVIEW_LIMITS.displayNameLength) || null,
      };
    }
  } else {
    return outcome("invalid");
  }

  const headers = reviewProofHeaders(request, access);
  if (!headers) return outcome(access.kind === "account" ? "signin" : "receipt");
  headers.set("Content-Type", "application/json");
  const response = await callApi(path, { method, headers, body: JSON.stringify(body) }, WRITE_TIMEOUT_MS);
  if (!response) return outcome("unavailable");
  const envelope = await readEnvelope(response);
  if (!response.ok) {
    const flag = reviewFlagForApi(response.status, envelope.code, envelope.field, access);
    return outcome(flag, flag === "exists" ? existingReviewId(envelope) : null);
  }
  if (intent === "withdraw") return outcome("withdrawn");
  const published = (envelope.data as { published?: unknown } | null)?.published === true;
  if (intent === "edit") return outcome(published ? "updated" : "pending");
  return outcome(published ? "published" : "pending");
}

export function privateRedirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...PRIVATE_HEADERS } });
}

export function privateJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...PRIVATE_HEADERS },
  });
}

/** Where "Edit your review" leads for an existing review (the account page; a guest can't reach another order's review). */
export function existingReviewHref(access: ReviewAccess, reviewId: string): string | null {
  return access.kind === "account" ? `/account/reviews#written-${reviewId}` : null;
}

/**
 * The review form's POST. Without JavaScript: a 303 back to the page with the
 * outcome flag and the line's anchor. With it (`Accept: application/json`):
 * the same outcome as JSON, so the form keeps the buyer's text on an error.
 */
export async function handleReviewFormPost(
  request: Request,
  copyFor: (access: ReviewAccess) => Promise<ReviewFormCopy>,
): Promise<Response> {
  const form = await readReviewForm(request);
  const outcome = await submitReviewForm(request, form);
  const location = withReviewStatus(outcome.returnTo, outcome.flag, outcome.lineId, outcome.reviewRef);
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  if (!wantsJson) return privateRedirect(location);
  const success = ["published", "pending", "updated", "withdrawn"].includes(outcome.flag);
  const copy = await copyFor(outcome.access);
  return privateJson(200, {
    ok: success,
    flag: outcome.flag,
    location,
    message: reviewNoticeText(outcome.flag, copy),
    ...(outcome.flag === "exists" && outcome.reviewRef
      ? { editHref: existingReviewHref(outcome.access, outcome.reviewRef), editText: copy.reviewEditExistingText }
      : {}),
  });
}
