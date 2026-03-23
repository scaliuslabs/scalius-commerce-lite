/**
 * Generate a random uppercase alphanumeric discount code.
 * Excludes ambiguous characters (0, O, 1, I) for readability.
 */
export function generateDiscountCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
