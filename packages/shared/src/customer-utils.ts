import { z } from "zod";
import { parsePhoneNumber, isValidPhoneNumber } from "libphonenumber-js";

// Re-export for consumers that need direct validation (e.g. customer-auth)
export { isValidPhoneNumber } from "libphonenumber-js";

/**
 * Validate and format a phone number to E.164.
 * Returns the E.164 string or throws with a clear message.
 */
export function validateAndFormatPhone(
  input: string,
  allowedCountries?: string[],
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Phone number is required");

  if (!isValidPhoneNumber(trimmed)) {
    throw new Error("Invalid phone number format");
  }

  const parsed = parsePhoneNumber(trimmed);
  if (!parsed) throw new Error("Could not parse phone number");

  if (allowedCountries && allowedCountries.length > 0 && parsed.country) {
    if (!allowedCountries.includes(parsed.country)) {
      throw new Error(`Phone numbers from ${parsed.country} are not accepted`);
    }
  }

  return parsed.format("E.164");
}

/**
 * Format E.164 phone for display (international format).
 */
export function formatPhoneForDisplay(e164: string): string {
  try {
    const parsed = parsePhoneNumber(e164);
    return parsed ? parsed.formatInternational() : e164;
  } catch {
    return e164;
  }
}

// Phone number validation schema — validates and transforms to E.164
export const phoneNumberSchema = z
  .string()
  .min(7, "Phone number too short")
  .max(16, "Phone number too long")
  .transform((val) => validateAndFormatPhone(val));

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
