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
