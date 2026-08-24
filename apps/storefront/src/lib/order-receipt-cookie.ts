const RECEIPT_COOKIE_PREFIX = "scalius_receipt_";
const RECEIPT_FINALIZE_COOKIE_PREFIX = "scalius_receipt_finalize_";
export const ORDER_RECEIPT_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const ORDER_RECEIPT_FINALIZE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function safeCookieNameSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 48) || "order";
}

export function getOrderReceiptCookieName(orderId: string): string {
  const normalized = orderId.trim();
  return `${RECEIPT_COOKIE_PREFIX}${safeCookieNameSegment(normalized)}_${fnv1a32(normalized)}`;
}

export function getOrderReceiptFinalizeCookieName(orderId: string): string {
  const normalized = orderId.trim();
  return `${RECEIPT_FINALIZE_COOKIE_PREFIX}${safeCookieNameSegment(normalized)}_${fnv1a32(normalized)}`;
}

export function createOrderReceiptCookieHeader(orderId: string, receiptToken: string): string | null {
  const normalizedOrderId = orderId.trim();
  const normalizedToken = receiptToken.trim();
  if (!normalizedOrderId || !normalizedToken) return null;

  return [
    `${getOrderReceiptCookieName(normalizedOrderId)}=${encodeURIComponent(normalizedToken)}`,
    `Max-Age=${ORDER_RECEIPT_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function createOrderReceiptFinalizeCookieHeader(orderId: string): string | null {
  const normalizedOrderId = orderId.trim();
  if (!normalizedOrderId) return null;

  return [
    `${getOrderReceiptFinalizeCookieName(normalizedOrderId)}=1`,
    `Max-Age=${ORDER_RECEIPT_FINALIZE_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/order-success",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function clearOrderReceiptFinalizeCookieHeader(orderId: string): string | null {
  const normalizedOrderId = orderId.trim();
  if (!normalizedOrderId) return null;

  return [
    `${getOrderReceiptFinalizeCookieName(normalizedOrderId)}=`,
    "Max-Age=0",
    "Path=/order-success",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function hasOrderReceiptFinalizeCookie(
  cookieHeader: string | null | undefined,
  orderId: string,
): boolean {
  const normalizedOrderId = orderId.trim();
  if (!cookieHeader || !normalizedOrderId) return false;

  const cookieName = getOrderReceiptFinalizeCookieName(normalizedOrderId);
  return cookieHeader.split(";").some((part) => {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    return rawName === cookieName && rawValueParts.join("=") === "1";
  });
}

export function readOrderReceiptCookie(cookieHeader: string | null | undefined, orderId: string): string {
  const normalizedOrderId = orderId.trim();
  if (!cookieHeader || !normalizedOrderId) return "";

  const cookieName = getOrderReceiptCookieName(normalizedOrderId);
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== cookieName) continue;

    const rawValue = rawValueParts.join("=");
    try {
      return decodeURIComponent(rawValue).trim();
    } catch {
      return rawValue.trim();
    }
  }

  return "";
}
