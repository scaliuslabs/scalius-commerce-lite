// Server side of buyer conversations: the reads the inbox pages and the order
// thread panel render with, and the writes the same-origin form proxies
// (`pages/api/conversations/**`) make. Every call goes to the API through the
// storefront's proxy transport (service binding in production).
//
// Credentials: the account session travels as the `cs_tok` cookie only; a guest
// order's receipt proof is read from its httpOnly cookie and sent only as the
// X-Receipt-Token header. Neither enters a URL, a response body or a log line,
// and nothing here logs message text.

import { resolveBackendTarget } from "@/lib/api/transport";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import {
  normalizeConversationBody,
  normalizeConversationSubject,
} from "@scalius/shared/conversation";
import {
  checkAttachmentFiles,
  conversationAttachmentUrl,
  conversationStatusMessage,
  isClientMessageKey,
  isConversationAttachmentId,
  isConversationId,
  isOrderId,
  renderConversationMessages,
  safeConversationReturnPath,
  statusFlagForApiStatus,
  withConversationStatus,
  type BuyerConversationThread,
  type BuyerInboxPage,
  type ConversationAccess,
  type ConversationStatusFlag,
} from "@/lib/account-inbox";

const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 20_000;
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(cs_tok=[^;]+)/;
/** Three 5 MiB images plus the text fields and multipart framing. */
export const MAX_FORM_BYTES = 3 * 5 * 1024 * 1024 + 256 * 1024;

/** Which thread a request acts on. */
export type ConversationTarget =
  | { kind: "thread"; conversationId: string }
  | { kind: "order"; orderId: string; access: ConversationAccess };

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "signed_out" | "no_access" | "unavailable" };

/** Only the account session cookie, never the rest of the buyer's cookies. */
export function sessionCookieOf(request: Request): string | null {
  return request.headers.get("cookie")?.match(SESSION_COOKIE_PATTERN)?.[1] ?? null;
}

/** API headers proving the buyer, or null when this browser has no proof. */
export function buyerCredentialHeaders(request: Request, target: ConversationTarget): Headers | null {
  const headers = new Headers({ Accept: "application/json" });
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  if (target.kind === "order" && target.access === "receipt") {
    const proof = readOrderReceiptCookie(request.headers.get("cookie"), target.orderId);
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

/** API paths per target. Ids only; the proof is never part of a path or query. */
export function conversationApiPaths(target: ConversationTarget) {
  if (target.kind === "thread") {
    const base = `/api/v1/customer-auth/conversations/${encode(target.conversationId)}`;
    return {
      read: base,
      post: `${base}/messages`,
      markRead: `${base}/read`,
      upload: "/api/v1/customer-auth/conversation-attachments",
      attachment: (attachmentId: string) => `${base}/attachments/${encode(attachmentId)}`,
    };
  }
  if (target.access === "account") {
    const base = `/api/v1/customer-auth/orders/${encode(target.orderId)}/conversation`;
    return {
      read: base,
      post: base,
      markRead: null,
      upload: "/api/v1/customer-auth/conversation-attachments",
      attachment: null,
    };
  }
  const base = `/api/v1/orders/receipt/${encode(target.orderId)}`;
  return {
    read: `${base}/conversation`,
    post: `${base}/conversation`,
    markRead: `${base}/conversation/read`,
    upload: `${base}/conversation-attachments`,
    attachment: (attachmentId: string) => `${base}/conversation/attachments/${encode(attachmentId)}`,
  };
}

async function callApi(path: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const target = resolveBackendTarget(path);
  if (!target) return null;
  try {
    return await target.fetch(target.url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.warn("[conversations] API call failed:", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function readFailure(status: number | null): ReadResult<never> {
  if (status === 401) return { ok: false, reason: "signed_out" };
  if (status === 403 || status === 404) return { ok: false, reason: "no_access" };
  return { ok: false, reason: "unavailable" };
}

async function envelopeData<T>(response: Response): Promise<T | null> {
  const payload = await response.json().catch(() => null) as { success?: unknown; data?: unknown } | null;
  return payload && payload.success === true && payload.data && typeof payload.data === "object"
    ? payload.data as T
    : null;
}

function isThread(value: unknown): value is BuyerConversationThread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<BuyerConversationThread>;
  return isConversationId(thread.id) && Array.isArray(thread.messages) && typeof thread.lastSeq === "number";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readInbox(request: Request, cursor?: string): Promise<ReadResult<BuyerInboxPage>> {
  const session = sessionCookieOf(request);
  if (!session) return { ok: false, reason: "signed_out" };
  const headers = new Headers({ Accept: "application/json", Cookie: session });
  const response = await callApi(
    withQuery("/api/v1/customer-auth/conversations", { cursor }),
    { method: "GET", headers },
    READ_TIMEOUT_MS,
  );
  if (!response?.ok) return readFailure(response?.status ?? null);
  const data = await envelopeData<BuyerInboxPage>(response);
  if (!data || !Array.isArray(data.items)) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    data: {
      items: data.items,
      nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
      canStartStoreConversation: data.canStartStoreConversation === true,
    },
  };
}

/** One thread (null for an order nobody has written about yet). */
export async function readConversation(
  request: Request,
  target: ConversationTarget,
  beforeSeq?: number,
): Promise<ReadResult<BuyerConversationThread | null>> {
  const headers = buyerCredentialHeaders(request, target);
  if (!headers) return { ok: false, reason: target.kind === "order" && target.access === "receipt" ? "no_access" : "signed_out" };
  const response = await callApi(
    withQuery(conversationApiPaths(target).read, { beforeSeq }),
    { method: "GET", headers },
    READ_TIMEOUT_MS,
  );
  if (!response?.ok) return readFailure(response?.status ?? null);
  const data = await envelopeData<{ conversation?: unknown }>(response);
  if (!data) return { ok: false, reason: "unavailable" };
  if (data.conversation === null) return { ok: true, data: null };
  return isThread(data.conversation) ? { ok: true, data: data.conversation } : { ok: false, reason: "unavailable" };
}

/**
 * Marks the thread read up to the last message shown. Best effort: a failed
 * marker only leaves the unread dot until the next view.
 */
export async function markConversationRead(
  request: Request,
  target: ConversationTarget,
  thread: BuyerConversationThread,
): Promise<void> {
  const lastShown = thread.messages.reduce((max, message) => Math.max(max, message.seq), 0);
  if (lastShown <= thread.readSeq) return;
  // An account order thread is marked through its conversation id.
  const readTarget: ConversationTarget = target.kind === "order" && target.access === "account"
    ? { kind: "thread", conversationId: thread.id }
    : target;
  const path = conversationApiPaths(readTarget).markRead;
  const headers = buyerCredentialHeaders(request, readTarget);
  if (!path || !headers) return;
  headers.set("Content-Type", "application/json");
  await callApi(path, { method: "POST", headers, body: JSON.stringify({ seq: lastShown }) }, READ_TIMEOUT_MS);
}

/** The image URL builder for a thread as this buyer reaches it. */
export function attachmentUrlFor(target: ConversationTarget, thread: Pick<BuyerConversationThread, "id">) {
  return (attachmentId: string) => target.kind === "order" && target.access === "receipt"
    ? conversationAttachmentUrl({ access: "receipt", orderId: target.orderId }, attachmentId)
    : conversationAttachmentUrl({ access: "account", conversationId: thread.id }, attachmentId);
}

/** Streams one private image through the storefront origin. Never cached, never sniffed. */
export async function proxyConversationAttachment(
  request: Request,
  target: ConversationTarget,
  attachmentId: string,
): Promise<Response> {
  const notFound = () => new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
  const build = conversationApiPaths(target).attachment;
  if (!build || !isConversationAttachmentId(attachmentId)) return notFound();
  const headers = buyerCredentialHeaders(request, target);
  if (!headers) return notFound();
  headers.set("Accept", "image/webp");
  const response = await callApi(build(attachmentId), { method: "GET", headers }, READ_TIMEOUT_MS);
  if (!response?.ok || !response.body || response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "image/webp") {
    await response?.body?.cancel().catch(() => undefined);
    return notFound();
  }
  const out = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  const length = response.headers.get("Content-Length");
  if (length) out.set("Content-Length", length);
  return new Response(response.body, { status: 200, headers: out });
}

// ---------------------------------------------------------------------------
// Writes (form posts)
// ---------------------------------------------------------------------------

export type WriteResult =
  | { ok: true; flag: ConversationStatusFlag; thread: BuyerConversationThread }
  | { ok: false; flag: ConversationStatusFlag; message?: string };

/** The API's own sentence for refusals the buyer can act on (validation, limits). */
async function apiRefusalMessage(response: Response): Promise<string | undefined> {
  if (![400, 403, 409, 429].includes(response.status)) return undefined;
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const error = payload?.error;
  const message = typeof error === "string"
    ? error
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
  return message && message.length <= 300 ? message : undefined;
}

async function refusal(response: Response | null, action: "post" | "start" | "upload"): Promise<WriteResult> {
  if (!response) return { ok: false, flag: "unavailable" };
  return {
    ok: false,
    flag: statusFlagForApiStatus(response.status, action),
    message: await apiRefusalMessage(response),
  };
}

async function threadFrom(response: Response): Promise<BuyerConversationThread | null> {
  const data = await envelopeData<{ conversation?: unknown }>(response);
  return isThread(data?.conversation) ? data.conversation : null;
}

async function uploadImages(
  request: Request,
  target: ConversationTarget,
  files: File[],
): Promise<{ ok: true; ids: string[] } | { ok: false; result: WriteResult }> {
  const ids: string[] = [];
  const path = conversationApiPaths(target).upload;
  for (const file of files) {
    const headers = buyerCredentialHeaders(request, target);
    if (!headers) return { ok: false, result: { ok: false, flag: "missing" } };
    const form = new FormData();
    form.append("file", file, file.name || "image");
    if (target.kind === "thread") form.append("conversationId", target.conversationId);
    else if (target.access === "account") form.append("orderId", target.orderId);
    const response = await callApi(path, { method: "POST", headers, body: form }, UPLOAD_TIMEOUT_MS);
    if (!response || response.status !== 201) return { ok: false, result: await refusal(response, "upload") };
    const data = await envelopeData<{ attachmentId?: unknown }>(response);
    if (!isConversationAttachmentId(data?.attachmentId)) return { ok: false, result: { ok: false, flag: "image" } };
    ids.push(data.attachmentId);
  }
  return { ok: true, ids };
}

/** Reads the posted form: the fields, or why it can't be read (too large or not a form). */
export async function readConversationForm(
  request: Request,
): Promise<{ ok: true; form: FormData } | { ok: false; flag: ConversationStatusFlag }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return { ok: false, flag: "image" };
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) {
    return { ok: false, flag: "invalid" };
  }
  try {
    return { ok: true, form: await request.formData() };
  } catch {
    return { ok: false, flag: "invalid" };
  }
}

/** Uploads the chosen images (at most three), then posts the message with them. */
export async function sendConversationMessage(
  request: Request,
  target: ConversationTarget,
  form: FormData,
): Promise<WriteResult> {
  const result = await sendWithImages(request, target, form);
  // A guest has no session to renew: a refused receipt proof means this browser lost access.
  return !result.ok && result.flag === "signin" && target.kind === "order" && target.access === "receipt"
    ? { ok: false, flag: "missing" }
    : result;
}

async function sendWithImages(
  request: Request,
  target: ConversationTarget,
  form: FormData,
): Promise<WriteResult> {
  const body = normalizeConversationBody(form.get("body"));
  const clientMessageKey = form.get("clientMessageKey");
  if (!body.ok || !isClientMessageKey(clientMessageKey)) return { ok: false, flag: "invalid" };
  const images = checkAttachmentFiles(form.getAll("images"));
  if (!images.ok) return { ok: false, flag: "image" };
  if (!buyerCredentialHeaders(request, target)) {
    return { ok: false, flag: target.kind === "order" && target.access === "receipt" ? "missing" : "signin" };
  }

  let attachmentIds: string[] = [];
  if (images.files.length > 0) {
    const uploaded = await uploadImages(request, target, images.files);
    if (!uploaded.ok) return uploaded.result;
    attachmentIds = uploaded.ids;
  }

  const headers = buyerCredentialHeaders(request, target)!;
  headers.set("Content-Type", "application/json");
  const response = await callApi(conversationApiPaths(target).post, {
    method: "POST",
    headers,
    body: JSON.stringify({
      body: body.value,
      clientMessageKey,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
  }, WRITE_TIMEOUT_MS);
  if (!response || response.status !== 201) return refusal(response, "post");
  const thread = await threadFrom(response);
  return thread ? { ok: true, flag: "sent", thread } : { ok: false, flag: "unavailable" };
}

/** Starts a store conversation (verified accounts only). */
export async function startStoreConversation(request: Request, form: FormData): Promise<WriteResult> {
  const subject = normalizeConversationSubject(form.get("subject"));
  const body = normalizeConversationBody(form.get("body"));
  const clientMessageKey = form.get("clientMessageKey");
  if (!subject.ok || !body.ok || !isClientMessageKey(clientMessageKey)) return { ok: false, flag: "invalid" };
  const session = sessionCookieOf(request);
  if (!session) return { ok: false, flag: "signin" };
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json", Cookie: session });
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  const response = await callApi("/api/v1/customer-auth/conversations", {
    method: "POST",
    headers,
    body: JSON.stringify({ subject: subject.value, body: body.value, clientMessageKey }),
  }, WRITE_TIMEOUT_MS);
  if (!response || response.status !== 201) return refusal(response, "start");
  const thread = await threadFrom(response);
  return thread ? { ok: true, flag: "started", thread } : { ok: false, flag: "unavailable" };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;

/** An enhanced (fetch) post asks for JSON; a plain form post gets a redirect. */
export function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.toLowerCase().includes("application/json") ?? false;
}

export function conversationJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...PRIVATE_HEADERS },
  });
}

export function conversationRedirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...PRIVATE_HEADERS } });
}

const JSON_STATUS: Partial<Record<ConversationStatusFlag, number>> = {
  invalid: 400,
  image: 400,
  signin: 401,
  unverified: 403,
  missing: 404,
  limit: 409,
  rate: 429,
  unavailable: 503,
};

/**
 * The answer to a form post. With JavaScript: JSON with the re-rendered
 * messages (same markup as the page). Without: 303 back to the page with only
 * the outcome flag in the URL.
 */
export function respondToConversationPost(
  request: Request,
  result: WriteResult,
  options: { returnTo: string; target?: ConversationTarget; redirectOnSuccess?: string },
): Response {
  if (wantsJson(request)) {
    if (!result.ok) {
      const message = result.message ?? conversationStatusMessage(result.flag).text;
      return conversationJson({ success: false, error: { code: result.flag, message } }, JSON_STATUS[result.flag] ?? 400);
    }
    const target = options.target ?? { kind: "thread", conversationId: result.thread.id };
    return conversationJson({
      success: true,
      data: {
        conversationId: result.thread.id,
        redirect: options.redirectOnSuccess ?? null,
        message: conversationStatusMessage(result.flag).text,
        messagesHtml: renderConversationMessages(result.thread.messages, {
          attachmentUrl: attachmentUrlFor(target, result.thread),
        }),
      },
    }, 201);
  }
  const destination = result.ok && options.redirectOnSuccess ? options.redirectOnSuccess : options.returnTo;
  return conversationRedirect(withConversationStatus(destination, result.flag));
}

/** The page a form came from, or the fallback. */
export function formReturnPath(form: FormData | null, fallback: string): string {
  return safeConversationReturnPath(form?.get("returnTo")) ?? fallback;
}

/** A cross-site post carrying the buyer's cookies is refused before any work. */
export function crossOriginRefusal(request: Request): Response {
  return wantsJson(request)
    ? conversationJson({ success: false, error: { code: "forbidden", message: "Cross-origin request denied." } }, 403)
    : new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });
}

/**
 * The whole form-post flow for a message: read the form, send it, answer with
 * JSON or a redirect back to `returnTo` (validated) or `fallbackReturn`.
 */
export async function handleConversationMessagePost(
  request: Request,
  target: ConversationTarget | null,
  fallbackReturn: string,
): Promise<Response> {
  const read = await readConversationForm(request);
  const returnTo = formReturnPath(read.ok ? read.form : null, fallbackReturn);
  if (!target) return respondToConversationPost(request, { ok: false, flag: "missing" }, { returnTo });
  if (!read.ok) return respondToConversationPost(request, { ok: false, flag: read.flag }, { returnTo });
  const result = await sendConversationMessage(request, target, read.form);
  return respondToConversationPost(request, result, { returnTo, target });
}

/** An order target from the route and the form's `access` field. */
export function orderTarget(orderId: string | undefined, access: unknown): ConversationTarget | null {
  if (!isOrderId(orderId)) return null;
  return { kind: "order", orderId, access: access === "account" ? "account" : "receipt" };
}
