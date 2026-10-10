// What a dashboard search term is (an email, a phone) and the phone's forms,
// shared by the order and customer lists.
import { toLatinDigits } from "@scalius/shared/phone-input";

const PHONE_DIGIT_MIN_LENGTH = 4;

/**
 * An FTS5 query for a phone column: any of the phone's forms as a prefix
 * token ("01712" finds +8801712…). The terms are digits only, so the query
 * needs no escaping. A stored "+880 1712-345678" is several tokens, so it
 * matches from its first group only.
 */
export function phonePrefixFtsQuery(column: string, terms: readonly string[]): string {
    return `${column} : (${terms.map((digits) => `${digits}*`).join(" OR ")})`;
}
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bangla (০–৯) and Arabic digits typed by the merchant read as Latin digits (R2-ORD-14). */
export { toLatinDigits };

/** A whole email address: matched exactly, never as a prefix of a longer one. */
export function isEmailSearch(input: string): boolean {
    return EMAIL_PATTERN.test(input.trim());
}

export function isLikelyPhoneSearch(input: string): boolean {
    const compact = input.replace(/\s/g, "");
    if (!compact) return false;

    const digits = digitsOnly(input);
    return digits.length >= PHONE_DIGIT_MIN_LENGTH && digits.length / compact.length > 0.5;
}

export function buildPhoneSearchTerms(input: string): string[] {
    const digits = digitsOnly(input);
    if (digits.length < PHONE_DIGIT_MIN_LENGTH) return [];

    const terms = new Set<string>([digits]);
    const withoutDialPrefix = digits.startsWith("00") ? digits.slice(2) : digits;
    terms.add(withoutDialPrefix);

    if (withoutDialPrefix.startsWith("880") && withoutDialPrefix.length > 3) {
        const nationalNumber = withoutDialPrefix.slice(3);
        terms.add(nationalNumber);
        terms.add(`0${nationalNumber}`);
    } else if (withoutDialPrefix.startsWith("0") && withoutDialPrefix.length > 1) {
        const nationalNumber = withoutDialPrefix.slice(1);
        terms.add(nationalNumber);
        terms.add(`880${nationalNumber}`);
    } else if (withoutDialPrefix.startsWith("1") && withoutDialPrefix.length >= 5) {
        terms.add(`0${withoutDialPrefix}`);
        terms.add(`880${withoutDialPrefix}`);
    }

    return [...terms].filter((term) => term.length >= PHONE_DIGIT_MIN_LENGTH);
}

function digitsOnly(input: string): string {
    return toLatinDigits(input).replace(/\D/g, "");
}
