/**
 * Phone typing rules shared by every buyer and merchant phone field. No
 * libphonenumber here, so browser bundles can import it on the critical path.
 */

const LOCAL_DIGIT_RANGES = [0x09e6, 0x0660, 0x06f0] as const; // Bengali, Arabic-Indic, Persian

/** Bengali (০-৯) and Arabic-Indic digits to 0-9; everything else unchanged. */
export function toLatinDigits(raw: string): string {
  return raw.replace(/[০-৯٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = LOCAL_DIGIT_RANGES.find((start) => code >= start && code <= start + 9)!;
    return String(code - base);
  });
}

/** A Bangladesh mobile number: 01, then 3-9, then 8 digits (with or without +880). */
const BD_MOBILE = /^(?:\+?880|0)?(1[3-9]\d{8})$/;

/** Digits in any script, spaces, dashes, dots and brackets removed. */
export function compactPhone(raw: string): string {
  return toLatinDigits(raw).replace(/[\s().-]/g, "");
}

/** `+8801XXXXXXXXX` for a valid Bangladesh mobile number, else null. */
export function normalizeBdMobile(raw: string): string | null {
  const match = BD_MOBILE.exec(compactPhone(raw));
  return match ? `+880${match[1]}` : null;
}

/** The one buyer-facing reason a Bangladesh number is refused. */
export const BD_MOBILE_REQUIRED_MESSAGE = "Enter a Bangladeshi mobile number (01XXXXXXXXX)";

/**
 * A number written as a Bangladesh number: +880/880, or a national number
 * starting with 0. Only mobile numbers (`01[3-9]` + 8 digits) are accepted for
 * these; landlines (02…) and 012… are refused with BD_MOBILE_REQUIRED_MESSAGE.
 */
export function isBangladeshNumber(raw: string): boolean {
  return /^(?:\+?880|0)\d/.test(compactPhone(raw));
}

/** "01712-345678" for a Bangladesh mobile number; any other value unchanged. */
export function formatBdMobile(phone: string): string {
  const e164 = normalizeBdMobile(phone);
  if (!e164) return phone;
  const local = `0${e164.slice(4)}`;
  return `${local.slice(0, 5)}-${local.slice(5)}`;
}
