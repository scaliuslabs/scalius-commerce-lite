const PHONE_DIGIT_MIN_LENGTH = 4;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bangla digits (০–৯) typed by the merchant read as Latin digits (R2-ORD-14). */
export function toLatinDigits(input: string): string {
    return input.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
}

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
