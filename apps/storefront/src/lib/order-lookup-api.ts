// Server side of the order-code pages (Track your order, Finish paying): the
// API calls, used both by the pages' no-JavaScript form posts and by the JSON
// proxies their scripts call. The receipt token only ever becomes an httpOnly
// cookie; it is never returned to the browser or logged.
import { getAccountOwnerReceiptProof } from "@/lib/api/orders";
import { apiFetch } from "@/lib/api/transport";
import { getCustomerSessionTokenFromCookie } from "@/lib/customer-session-cookie";
import { createOrderReceiptCookieHeader } from "@/lib/order-receipt-cookie";
import {
  DEFAULT_RESEND_AFTER_SECONDS,
  positiveSeconds,
  type OrderCodeFailure,
} from "@/lib/order-lookup";

const ORDER_CODE_TIMEOUT_MS = 8_000;

export type OrderCodeResult<T> = { ok: true; data: T } | { ok: false; failure: OrderCodeFailure };

/** A verified order: where to go and the proof to store as a cookie. */
export interface VerifiedOrderReceipt {
  orderId: string;
  receiptToken: string;
  redirectUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** String fields of a JSON body or a form post; null when unreadable. */
export async function readOrderCodeFields(request: Request): Promise<Record<string, string> | null> {
  try {
    const isJson = request.headers.get("Content-Type")?.includes("application/json");
    const body: unknown = isJson ? await request.json() : Object.fromEntries(await request.formData());
    if (!isRecord(body)) return null;
    return Object.fromEntries(
      Object.entries(body).flatMap(([key, value]) => (typeof value === "string" ? [[key, value.trim()]] : [])),
    );
  } catch {
    return null;
  }
}

async function postOrderCodeApi(
  path: string,
  body: Record<string, string>,
  options: { auth: boolean; fallbackCode: string },
): Promise<OrderCodeResult<Record<string, unknown>>> {
  try {
    const response = await apiFetch(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
      { retries: 0, timeout: ORDER_CODE_TIMEOUT_MS, auth: options.auth },
    );
    const json: unknown = await response.json().catch(() => null);
    if (response.ok && isRecord(json) && json.success !== false) {
      return { ok: true, data: isRecord(json.data) ? json.data : {} };
    }
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    const details = isRecord(error.details) ? error.details : {};
    const retryAfterSeconds = positiveSeconds(details.retryAfterSeconds ?? response.headers.get("Retry-After"));
    const message = trimmedString(error.message);
    return {
      ok: false,
      failure: {
        status: response.ok ? 502 : response.status,
        errorCode: trimmedString(error.code) || options.fallbackCode,
        ...(message ? { message } : {}),
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        ...(typeof details.attemptsLeft === "number" ? { attemptsLeft: Math.max(0, details.attemptsLeft) } : {}),
      },
    };
  } catch (error) {
    console.error("[order-code] API request failed:", error instanceof Error ? error.name : typeof error);
    return { ok: false, failure: { status: 502, errorCode: options.fallbackCode } };
  }
}

/** A send the API accepted. `sent` is false when nothing went out (a neutral answer). */
export interface OrderCodeSent {
  sent: boolean;
  /** The API's sentence: "We sent a code to 01•••••678." or the neutral one. */
  message: string;
  resendAfterSeconds: number;
  orderNumber: number | null;
}

function sentResult(result: OrderCodeResult<Record<string, unknown>>): OrderCodeResult<OrderCodeSent> {
  if (!result.ok) return result;
  const { data } = result;
  return {
    ok: true,
    data: {
      sent: Boolean(trimmedString(data.destination)),
      message: trimmedString(data.message),
      resendAfterSeconds: positiveSeconds(data.resendAfterSeconds) ?? DEFAULT_RESEND_AFTER_SECONDS,
      orderNumber: typeof data.orderNumber === "number" && Number.isSafeInteger(data.orderNumber) ? data.orderNumber : null,
    },
  };
}

function verifiedResult(
  result: OrderCodeResult<Record<string, unknown>>,
  expectedOrderId: string | null,
  redirectUrl: (orderId: string, data: Record<string, unknown>) => string,
  unavailableCode: string,
): OrderCodeResult<VerifiedOrderReceipt> {
  if (!result.ok) return result;
  const orderId = trimmedString(result.data.orderId);
  const receiptToken = trimmedString(result.data.receiptToken);
  if (!orderId || !receiptToken || (expectedOrderId && orderId !== expectedOrderId)) {
    return { ok: false, failure: { status: 502, errorCode: unavailableCode } };
  }
  return { ok: true, data: { orderId, receiptToken, redirectUrl: redirectUrl(orderId, result.data) } };
}

/** A tracked order opens as a status page, not the checkout confirmation. */
function trackedReceiptUrl(orderId: string): string {
  return `/order-success?${new URLSearchParams({ orderId, view: "status" })}`;
}

/** Track your order: the buyer holds the number and phone, so the API says where the code went. */
export async function sendOrderLookupCode(input: { reference: string; phone: string }) {
  return sentResult(await postOrderCodeApi("/orders/lookup/send-otp", input, {
    auth: false,
    fallbackCode: "ORDER_LOOKUP_SEND_FAILED",
  }));
}

export async function verifyOrderLookupCode(input: { reference: string; phone: string; code: string }) {
  return verifiedResult(
    await postOrderCodeApi("/orders/lookup/verify-otp", input, {
      auth: true,
      fallbackCode: "ORDER_LOOKUP_VERIFICATION_FAILED",
    }),
    null,
    trackedReceiptUrl,
    "ORDER_LOOKUP_RECEIPT_UNAVAILABLE",
  );
}

/** Finish paying: the API picks where a code can reach the buyer, and stays neutral for other orders. */
export async function sendPaymentRecoveryCode(input: { orderId: string }) {
  return sentResult(await postOrderCodeApi(
    "/orders/payment-recovery/send-otp",
    { orderId: input.orderId },
    { auth: false, fallbackCode: "PAYMENT_RECOVERY_SEND_FAILED" },
  ));
}

export async function verifyPaymentRecoveryCode(input: { orderId: string; code: string }) {
  return verifiedResult(
    await postOrderCodeApi("/orders/payment-recovery/verify-otp", input, {
      auth: true,
      fallbackCode: "PAYMENT_RECOVERY_VERIFICATION_FAILED",
    }),
    input.orderId,
    (orderId, data) => paymentRecoveryReceiptUrl(orderId, isRecord(data.redirectParams) ? data.redirectParams : {}),
    "PAYMENT_RECOVERY_RECEIPT_UNAVAILABLE",
  );
}

/** The receipt, reopened on the payment the buyer was finishing. */
export function paymentRecoveryReceiptUrl(orderId: string, redirect: Record<string, unknown>): string {
  const params = new URLSearchParams({ orderId });
  for (const key of ["payment", "result", "paymentType"] as const) {
    const value = trimmedString(redirect[key]);
    if (value) params.set(key, value);
  }
  const deposit = typeof redirect.depositAmount === "string" && redirect.depositAmount.trim()
    ? Number(redirect.depositAmount)
    : redirect.depositAmount;
  if (typeof deposit === "number" && Number.isFinite(deposit)) params.set("depositAmount", String(deposit));
  return `/order-success?${params}`;
}

/**
 * A signed-in owner needs no code: their session proves the order, so they go
 * straight to the receipt (which says what, if anything, is left to pay).
 * Null when there is no session or it doesn't own the order.
 */
export async function accountOwnerReceiptRedirect(
  orderId: string,
  cookieHeader: string | null,
  search: URLSearchParams,
): Promise<Response | null> {
  const sessionToken = getCustomerSessionTokenFromCookie(cookieHeader);
  if (!orderId || !sessionToken) return null;
  const receiptToken = await getAccountOwnerReceiptProof(orderId, sessionToken).catch(() => null);
  if (!receiptToken) return null;
  const redirectUrl = paymentRecoveryReceiptUrl(orderId, Object.fromEntries(search));
  return verifiedReceiptResponse({ orderId, receiptToken, redirectUrl }, "redirect");
}

function orderCodeHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
}

/** The refusals whose API sentence the buyer sees: no such order, no way to reach them, too many codes. */
const BUYER_FACING_REFUSALS = new Set([404, 409, 429]);

/** JSON for the page scripts. Other API prose (provider or validation detail) stays on the server. */
export function orderCodeFailureResponse(failure: OrderCodeFailure): Response {
  const { status, errorCode, message, retryAfterSeconds, attemptsLeft } = failure;
  return new Response(JSON.stringify({
    success: false,
    errorCode,
    ...(message && BUYER_FACING_REFUSALS.has(status) ? { message } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
  }), {
    status,
    headers: orderCodeHeaders(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined),
  });
}

export function orderCodeJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: orderCodeHeaders() });
}

/** Verified: store the proof as the receipt cookie and say where to go. */
export function verifiedReceiptResponse(receipt: VerifiedOrderReceipt, mode: "json" | "redirect"): Response {
  const headers = mode === "json"
    ? orderCodeHeaders()
    : new Headers({ Location: receipt.redirectUrl, "Cache-Control": "no-store" });
  const cookie = createOrderReceiptCookieHeader(receipt.orderId, receipt.receiptToken);
  if (cookie) headers.append("Set-Cookie", cookie);
  return mode === "json"
    ? new Response(JSON.stringify({ success: true, redirectUrl: receipt.redirectUrl }), { status: 200, headers })
    : new Response(null, { status: 303, headers });
}
