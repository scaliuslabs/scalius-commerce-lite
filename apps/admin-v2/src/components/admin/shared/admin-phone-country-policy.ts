import {
  getCountries,
  parsePhoneNumber,
  type Country,
} from "react-phone-number-input";
import type { AllowedCountriesPayload } from "@/lib/api-functions/settings";

const supportedCountries = new Set(getCountries());

export function normalizePolicyCountries(
  data: AllowedCountriesPayload | undefined,
): Country[] {
  if (!Array.isArray(data?.allowedCountries)) return [];
  return [...new Set(data.allowedCountries)]
    .map((country) => country.trim().toUpperCase())
    .filter((country): country is Country => supportedCountries.has(country as Country));
}

function getPhoneCountry(value: string | null | undefined): Country | undefined {
  if (!value) return undefined;
  try {
    return parsePhoneNumber(value)?.country;
  } catch {
    return undefined;
  }
}

export function resolveSelectablePhoneCountries(
  configuredCountries: Country[],
  mode: string | undefined,
  preserveExistingValue?: string | null,
): Country[] | undefined {
  if (configuredCountries.length === 0) return undefined;

  const next = mode === "exclude"
    ? getCountries().filter((country) => !configuredCountries.includes(country))
    : [...configuredCountries];
  const preservedCountry = getPhoneCountry(preserveExistingValue);
  if (preservedCountry && !next.includes(preservedCountry)) {
    next.push(preservedCountry);
  }
  return next;
}
