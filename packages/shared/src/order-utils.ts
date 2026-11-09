import { localeDigits } from "./locale-format";

const ORDER_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ORDER_ID_LENGTH = 16;

/**
 * Generate a readable 80-bit order identity. The Crockford alphabet avoids
 * ambiguous I/L/O/U characters and its power-of-two size keeps byte mapping
 * unbiased. Existing six-character order IDs remain valid; only new IDs use
 * the collision-resistant format.
 */
export function generateOrderId(): string {
  const bytes = new Uint8Array(ORDER_ID_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => ORDER_ID_ALPHABET[byte & 31],
  ).join("");
}

/** First sequential order number a store hands out ("#1001"). */
export const FIRST_ORDER_NUMBER = 1001;

/**
 * The name merchants and buyers read aloud: "#1001". Falls back to the
 * internal id only for a payload without an order number.
 */
export function formatOrderNumber(orderNumber: number | null | undefined, fallbackId: string): string {
  return typeof orderNumber === "number" && Number.isSafeInteger(orderNumber) && orderNumber > 0
    ? `#${orderNumber}`
    : `#${fallbackId}`;
}

/**
 * The order number as a reader of `locale` reads it: "#১০১৭" in Bangla,
 * "#1017" in English. One rule for every surface written in a language (the
 * storefront, buyer messages, invoices and other documents, the dashboard):
 * an order number is a number people read and say, so it takes the reader's
 * digits, and searches accept either. Values other systems type or match
 * keep Latin digits: an order's id, discount codes, tracking ids, phone links,
 * API fields and exports.
 */
export function formatOrderNumberIn(orderNumber: number | null | undefined, fallbackId: string, locale: string): string {
  const text = formatOrderNumber(orderNumber, fallbackId);
  // An id (no number) is typed and matched elsewhere: it keeps its characters.
  return typeof orderNumber === "number" && text !== `#${fallbackId}` ? localeDigits(text, locale) : text;
}

/**
 * An order number already written ("#1017") in `locale`'s digits; any other
 * text (an order's id as its fallback reference) unchanged.
 */
export function orderNumberTextIn(text: string, locale: string): string {
  return /^#\d+$/u.test(text) ? localeDigits(text, locale) : text;
}

/**
 * Reads an order-number search ("#1001", "1001", "১০০১") as its integer, or
 * null when the text is not an order number.
 */
export function parseOrderNumberSearch(input: string): number | null {
  const ascii = input.trim().replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
  const match = /^#?\s*(\d{1,9})$/.exec(ascii);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
