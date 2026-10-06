/**
 * A country's phone facts for a phone field: its calling code and one example
 * mobile number from libphonenumber's metadata, written both ways a buyer may
 * type it. Server rendering and the lazily loaded international validator use
 * it; the Bangladesh fast path of the checkout field never needs it.
 */
import {
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  type CountryCode,
} from "libphonenumber-js";
import examples from "libphonenumber-js/mobile/examples";

export interface PhoneCountryMeta {
  /** `+91` */
  code: string;
  /** `+91 81234 56789`: the example with its country code, null when libphonenumber has none. */
  example: string | null;
  /** `081234 56789`: the same number as typed inside the country. */
  national: string | null;
}

/** The facts of an ISO country code, or null when libphonenumber does not know the country. */
export function phoneCountryMeta(country: string): PhoneCountryMeta | null {
  const code = country.trim().toUpperCase();
  if (!isSupportedCountry(code)) return null;
  const example = getExampleNumber(code as CountryCode, examples);
  return {
    code: `+${getCountryCallingCode(code as CountryCode)}`,
    example: example?.formatInternational() ?? null,
    national: example?.formatNational() ?? null,
  };
}
