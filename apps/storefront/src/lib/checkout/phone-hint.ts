// The checkout phone field's words for a country: the hint under it, which
// follows the delivery mode (courier, pickup, updates), and its placeholder.
// Bangladesh keeps the merchant's own copy (a local 01… mobile number); any
// other country asks for the country code and shows a libphonenumber example.
// Browser safe: no libphonenumber here; the example comes in as data.
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { PhoneCountryMeta } from "@scalius/shared/phone-example";

export type PhoneHintMode = "delivery" | "pickup" | "none";

export interface PhoneHintCopy {
  /** Bangladesh: what the delivery, pickup and no-delivery hints say. */
  help: string;
  pickupHelp: string;
  serviceHelp: string;
  /** Any other country: the same three, asking for the country code. */
  intlHelp: string;
  intlPickupHelp: string;
  intlServiceHelp: string;
  /** "Example: {example}" */
  exampleText: string;
  /** The Bangladesh placeholder; another country shows its own example. */
  placeholder: string;
  /** The field's label: the placeholder when no example exists. */
  label: string;
}

export interface PhoneHints {
  hints: Record<PhoneHintMode, string>;
  placeholder: string;
}

/** The checkout-language keys the phone hint reads (see `phoneHintCopy`). */
export interface PhoneHintLanguage {
  customerPhoneLabel: string;
  customerPhonePlaceholder: string;
  customerPhoneHelp: string;
  customerPhonePickupHelp: string;
  customerPhoneServiceHelp: string;
  customerPhoneIntlHelp: string;
  customerPhoneIntlPickupHelp: string;
  customerPhoneIntlServiceHelp: string;
  customerPhoneExampleText: string;
}

export function phoneHintCopy(language: PhoneHintLanguage): PhoneHintCopy {
  return {
    help: language.customerPhoneHelp,
    pickupHelp: language.customerPhonePickupHelp,
    serviceHelp: language.customerPhoneServiceHelp,
    intlHelp: language.customerPhoneIntlHelp,
    intlPickupHelp: language.customerPhoneIntlPickupHelp,
    intlServiceHelp: language.customerPhoneIntlServiceHelp,
    exampleText: language.customerPhoneExampleText,
    placeholder: language.customerPhonePlaceholder,
    label: language.customerPhoneLabel,
  };
}

/**
 * What the field says for `country`. `meta` is the country's example (null
 * when libphonenumber has none: the hint then names no example).
 */
export function phoneHints(
  country: string,
  copy: PhoneHintCopy,
  meta: Pick<PhoneCountryMeta, "example" | "national"> | null,
): PhoneHints {
  if (country === "BD") {
    return {
      hints: { delivery: copy.help, pickup: copy.pickupHelp, none: copy.serviceHelp },
      placeholder: copy.placeholder,
    };
  }
  const example = meta?.example
    ? ` ${formatCheckoutLanguageText(copy.exampleText, { example: meta.example })}`
    : "";
  return {
    hints: {
      delivery: `${copy.intlHelp}${example}`,
      pickup: `${copy.intlPickupHelp}${example}`,
      none: `${copy.intlServiceHelp}${example}`,
    },
    placeholder: meta?.national ?? copy.label,
  };
}
