import { z } from "zod";
import { parsePhoneNumber, isValidPhoneNumber } from "libphonenumber-js";
import { addPrices } from "./price-utils";

// Re-export for consumers that need direct validation (e.g. customer-auth)
export { isValidPhoneNumber } from "libphonenumber-js";

export type PhoneCountryPolicyMode = "include" | "exclude";

export interface PhoneCountryPolicy {
  countries?: readonly string[];
  mode?: PhoneCountryPolicyMode;
}

type PhoneCountryPolicyInput = readonly string[] | PhoneCountryPolicy | undefined;
type ParsedPhoneNumber = NonNullable<ReturnType<typeof parsePhoneNumber>>;

export function normalizePhoneCountryCodes(countries: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const country of countries ?? []) {
    const code = country.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      normalized.add(code);
    }
  }
  return [...normalized];
}

export function normalizePhoneCountryPolicy(policy: PhoneCountryPolicyInput): Required<PhoneCountryPolicy> {
  if (Array.isArray(policy)) {
    return {
      countries: normalizePhoneCountryCodes(policy),
      mode: "include",
    };
  }

  const objectPolicy = policy as PhoneCountryPolicy | undefined;
  return {
    countries: normalizePhoneCountryCodes(objectPolicy?.countries),
    mode: objectPolicy?.mode === "exclude" ? "exclude" : "include",
  };
}

function assertParsedPhoneCountryAllowed(parsed: ParsedPhoneNumber, policy: PhoneCountryPolicyInput): void {
  const normalizedPolicy = normalizePhoneCountryPolicy(policy);
  if (normalizedPolicy.countries.length === 0) return;

  const restrictedCountries = new Set(normalizedPolicy.countries);
  const country = parsed.country?.toUpperCase();
  const countryLabel = country ?? "this country";
  const isConfiguredCountry = country ? restrictedCountries.has(country) : false;

  if (normalizedPolicy.mode === "include" && !isConfiguredCountry) {
    throw new Error(`Phone numbers from ${countryLabel} are not accepted`);
  }

  if (normalizedPolicy.mode === "exclude" && isConfiguredCountry) {
    throw new Error(`Phone numbers from ${countryLabel} are not accepted`);
  }
}

export function assertPhoneCountryAllowed(input: string, policy: PhoneCountryPolicyInput): void {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Phone number is required");

  const parsed = parsePhoneNumber(trimmed);
  if (!parsed) throw new Error("Could not parse phone number");

  assertParsedPhoneCountryAllowed(parsed, policy);
}

/**
 * Validate and format a phone number to E.164.
 * Returns the E.164 string or throws with a clear message.
 */
export function validateAndFormatPhone(
  input: string,
  allowedCountries?: PhoneCountryPolicyInput,
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Phone number is required");

  if (!isValidPhoneNumber(trimmed)) {
    throw new Error("Invalid phone number format");
  }

  const parsed = parsePhoneNumber(trimmed);
  if (!parsed) throw new Error("Could not parse phone number");

  assertParsedPhoneCountryAllowed(parsed, allowedCountries);

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

/**
 * Format E.164 phone to local/national format for delivery providers.
 * E.g., "+8801712345678" → "01712345678" (strips country code, keeps leading 0)
 * Falls back to stripping "+" if parsing fails.
 */
export function formatPhoneForProvider(e164: string): string {
  try {
    const parsed = parsePhoneNumber(e164);
    if (parsed) {
      return parsed.formatNational().replace(/[\s\-()]/g, "");
    }
  } catch {
    // Fall through to basic cleanup
  }
  // Basic fallback: strip + prefix
  return e164.replace(/^\+/, "");
}

// Phone number validation schema — validates and transforms to E.164
export const phoneNumberSchema = z
  .string()
  .min(7, "Phone number too short")
  .max(16, "Phone number too long")
  .transform((val, context) => {
    try {
      return validateAndFormatPhone(val);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid phone number format",
      });
      return z.NEVER;
    }
  });

/**
 * Updates customer stats based on an order
 */
export function calculateCustomerStats(
  orders: {
    paidAmount: number;
    createdAt: Date | number;
  }[],
) {
  const totalOrders = orders.length;
  const totalSpent = addPrices(
    ...orders.map((order) => Math.max(0, Number(order.paidAmount) || 0)),
  );
  const lastOrderAt =
    orders.length > 0
      ? Math.max(
          ...orders.map((o) =>
            o.createdAt instanceof Date
              ? o.createdAt.getTime()
              : o.createdAt < 1_000_000_000_000
                ? o.createdAt * 1000
                : o.createdAt,
          ),
        )
      : null;

  return {
    totalOrders,
    totalSpent,
    lastOrderAt: lastOrderAt ? new Date(lastOrderAt) : null,
  };
}
