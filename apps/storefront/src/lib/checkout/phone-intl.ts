// International phone support for the checkout phone field. Loaded on demand:
// only when a buyer opens the country picker or types a number the
// Bangladesh-mobile fast path in ./phone-field cannot decide.
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type PhoneCountryPolicy,
} from "@scalius/shared/customer-utils";
import { validateStorefrontPhone } from "@/lib/phone-country-policy";
import type { CheckoutPhoneResult } from "./phone-field";

type CountryCode = Parameters<typeof getCountryCallingCode>[0];

/** Full libphonenumber validation, reading a national number in `country`. */
export function validateInternationalPhone(
  raw: string,
  policy: PhoneCountryPolicy,
  country: string,
): CheckoutPhoneResult {
  const trimmed = raw.trim();
  const international = trimmed.startsWith("+")
    ? trimmed
    : (parsePhoneNumberFromString(trimmed, country as CountryCode)?.number ?? trimmed);
  const result = validateStorefrontPhone(international, policy);
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    value: "",
    message: !trimmed
      ? "required"
      : result.message?.includes("does not accept")
        ? "country"
        : "invalid",
  };
}

export function callingCode(country: string): string {
  return `+${getCountryCallingCode(country as CountryCode)}`;
}

/** A native country select limited to the merchant's phone country policy. */
export function createCountrySelect(options: {
  policy: Required<PhoneCountryPolicy>;
  selected: string;
  label: string;
  languageCode: string;
}): HTMLSelectElement {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([options.languageCode, "en"], { type: "region" });
  } catch {
    names = null;
  }
  const listed = new Set(options.policy.countries);
  const countries = getCountries()
    .filter((country) =>
      listed.size === 0 ||
      (options.policy.mode === "exclude" ? !listed.has(country) : listed.has(country)))
    .map((country) => ({ country, name: names?.of(country) || country }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const select = document.createElement("select");
  select.setAttribute("aria-label", options.label);
  select.dataset.phoneCountrySelect = "";
  // Invisible over the calling-code button: the native picker opens on tap
  // while the button keeps showing the selected calling code.
  select.className = "absolute inset-0 h-full w-full cursor-pointer opacity-0";
  for (const { country, name } of countries) {
    const option = new Option(`${name} ${callingCode(country)}`, country);
    option.selected = country === options.selected;
    select.append(option);
  }
  return select;
}
