import { z } from "zod";
// "#libphonenumber" (package.json "imports") is the full `max` metadata on the
// server (Workers, Node, tests): validation checks each country's number
// patterns, not only lengths. Browser bundles keep the small default metadata,
// so a browser may accept a number the API refuses; the API is the authority.
import { parsePhoneNumber, isSupportedCountry, isValidPhoneNumber, type CountryCode } from "#libphonenumber";
import { BD_MOBILE_REQUIRED_MESSAGE, compactPhone, isBangladeshNumber, normalizeBdMobile, toLatinDigits } from "./phone-input";

// Re-exported for browser code that lazy-loads full validation (customer auth,
// the checkout phone country picker) without its own libphonenumber dependency.
export {
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from "#libphonenumber";

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

/**
 * The phone countries a store accepts: the merchant's customer-country policy
 * united with every country an active market sells to (MARKETS-DESIGN step
 * 3b). A buyer shipping to a market must be able to give a number from there,
 * so a market country is accepted whatever the policy says, and the policy
 * only adds countries (include) or refuses countries no market sells to
 * (exclude). One rule for the storefront, the API and core:
 *
 * - no policy (an empty list): every country, as before;
 * - include `L`: `L` and the market countries;
 * - exclude `X`: `X` without the market countries (nothing left: every country).
 *
 * `marketCountries` absent or empty leaves the policy as it is. The merchant's
 * order is kept, market additions follow in the order given.
 */
export function acceptedPhoneCountryPolicy(
  policy: PhoneCountryPolicyInput,
  marketCountries: readonly string[] | undefined,
): Required<PhoneCountryPolicy> {
  const merchant = normalizePhoneCountryPolicy(policy);
  const markets = normalizePhoneCountryCodes(marketCountries);
  if (merchant.countries.length === 0 || markets.length === 0) return merchant;
  if (merchant.mode === "exclude") {
    const sold = new Set(markets);
    return { countries: merchant.countries.filter((country) => !sold.has(country)), mode: "exclude" };
  }
  const listed = new Set(merchant.countries);
  return { countries: [...merchant.countries, ...markets.filter((country) => !listed.has(country))], mode: "include" };
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

function parseBdLandline(raw: string): ParsedPhoneNumber | null {
  const compact = compactPhone(raw);
  if (!compact || normalizeBdMobile(compact)) return null;
  try {
    const parsed = parsePhoneNumber(compact, "BD");
    // National numbers starting with 1 are mobiles; only normalizeBdMobile decides those.
    return parsed?.isValid() && parsed.country === "BD" && !parsed.nationalNumber.startsWith("1") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A Bangladesh landline or hotline (02-9876543, 031-714567, 09612-345678) in
 * any typing, as `+880…`; null for anything else, mobiles included. Only for
 * the store's own published phone: buyer phones stay mobile-only.
 */
export function normalizeBdLandline(raw: string): string | null {
  return parseBdLandline(raw)?.number ?? null;
}

/** "02-9876543" for a Bangladesh landline stored as `+880…`; any other value unchanged. */
export function formatBdLandline(phone: string): string {
  return phone.startsWith("+880") ? parseBdLandline(phone)?.formatNational() ?? phone : phone;
}

/**
 * Validate and format a phone number to E.164.
 * Returns the E.164 string or throws with a clear message.
 */
export function validateAndFormatPhone(
  input: string,
  allowedCountries?: PhoneCountryPolicyInput,
  /**
   * The address country a national number (without `+`) is read in
   * (MARKETS-DESIGN D7). Absent or BD: Bangladesh's rules, exactly as before.
   */
  options: { defaultCountry?: string | null } = {},
): string {
  const defaultCountry = normalizePhoneCountryCodes(options.defaultCountry ? [options.defaultCountry] : [])[0] ?? null;
  const bangladeshContext = defaultCountry === null || defaultCountry === "BD";
  const international = compactPhone(input).startsWith("+");
  const mobile = bangladeshContext || international ? normalizeBdMobile(input) : null;
  const trimmed = mobile ?? toLatinDigits(input).trim();
  if (!trimmed) throw new Error("Phone number is required");
  // Bangladesh numbers must be mobile numbers: couriers call and codes are sent by SMS.
  if (!mobile && (bangladeshContext ? isBangladeshNumber(trimmed) : /^\+880/.test(compactPhone(trimmed)))) {
    throw new Error(BD_MOBILE_REQUIRED_MESSAGE);
  }

  const nationalCountry = !bangladeshContext && !trimmed.startsWith("+") && isSupportedCountry(defaultCountry!)
    ? defaultCountry as CountryCode
    : undefined;
  if (!(nationalCountry ? isValidPhoneNumber(trimmed, nationalCountry) : isValidPhoneNumber(trimmed))) {
    throw new Error("Invalid phone number format");
  }

  const parsed = nationalCountry ? parsePhoneNumber(trimmed, nationalCountry) : parsePhoneNumber(trimmed);
  if (!parsed) throw new Error("Could not parse phone number");
  if (parsed.country === "BD" && !normalizeBdMobile(parsed.number)) throw new Error(BD_MOBILE_REQUIRED_MESSAGE);

  assertParsedPhoneCountryAllowed(parsed, allowedCountries);

  return parsed.format("E.164");
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

// Phone number validation schema — validates and transforms to E.164.
// Pure-annotated so browser bundles that only need the phone helpers above
// tree-shake Zod away instead of shipping it.
export const phoneNumberSchema = /* @__PURE__ */ z
  .string()
  .min(7, "Phone number too short")
  .max(16, "Phone number too long")
  .transform((val, context) => {
    try {
      return validateAndFormatPhone(val);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error && error.message.includes("not accepted")
            ? error.message
            : "Enter a valid phone number",
      });
      return z.NEVER;
    }
  });

/**
 * Updates customer stats based on an order
 */
export function calculateCustomerStats(
  orders: {
    createdAt: Date | number;
  }[],
) {
  const totalOrders = orders.length;
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
    lastOrderAt: lastOrderAt ? new Date(lastOrderAt) : null,
  };
}
