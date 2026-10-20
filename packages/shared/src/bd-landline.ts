// Bangladesh landlines without the rest of the phone vocabulary: the store
// details page shows the store's own published phone (02-9876543) without
// downloading the validation schemas. `customer-utils.ts` re-exports these.
import { parsePhoneNumber } from "#libphonenumber";
import { compactPhone, normalizeBdMobile } from "./phone-input";

type ParsedPhoneNumber = NonNullable<ReturnType<typeof parsePhoneNumber>>;

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
