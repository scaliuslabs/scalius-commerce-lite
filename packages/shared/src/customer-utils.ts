import { z } from "zod";

// Phone number validation schema
export const phoneNumberSchema = z
  .string()
  .min(11, "Phone number must be at least 11 digits")
  .max(14, "Phone number must be at most 14 digits")
  .transform((phone) => standardizePhoneNumber(phone));

/**
 * Standardizes a phone number to the format: 01XXXXXXXXX
 * Handles various formats:
 * - +880 1XXX-XXXXXX
 * - +880 1XXXXXXXXX
 * - +8801XXXXXXXXX
 * - 01XXXXXXXXX
 */
export function standardizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");

  // If starts with 880, remove it
  const withoutCountryCode = digits.startsWith("880")
    ? digits.slice(3)
    : digits;

  // Ensure starts with 0
  const standardized = withoutCountryCode.startsWith("1")
    ? "0" + withoutCountryCode
    : withoutCountryCode;

  // Validate final format
  if (!/^01\d{9}$/.test(standardized)) {
    throw new Error("Invalid phone number format");
  }

  return standardized;
}

/**
 * Normalize a phone number to E.164 storage format.
 * Strips spaces, dashes, and parentheses. Prepends country code if missing.
 * Default country code: +880 (Bangladesh).
 *
 * Use this for DB storage. The existing standardizePhoneNumber() remains
 * for display purposes (local format).
 */
export function normalizePhone(
  phone: string,
  countryCode: string = "+880",
): string {
  let cleaned = phone.replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("0")) {
    cleaned = countryCode + cleaned.slice(1);
  }
  if (!cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }
  return cleaned;
}

/**
 * Updates customer stats based on an order
 */
export function calculateCustomerStats(
  orders: {
    totalAmount: number;
    createdAt: Date | number;
  }[],
) {
  const totalOrders = orders.length;
  const totalSpent = orders.reduce((sum, order) => sum + order.totalAmount, 0);
  const lastOrderAt =
    orders.length > 0
      ? Math.max(
          ...orders.map((o) =>
            o.createdAt instanceof Date ? o.createdAt.getTime() : o.createdAt,
          ),
        )
      : null;

  return {
    totalOrders,
    totalSpent,
    lastOrderAt: lastOrderAt ? new Date(lastOrderAt) : null,
  };
}
