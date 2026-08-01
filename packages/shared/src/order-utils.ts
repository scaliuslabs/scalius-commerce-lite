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
