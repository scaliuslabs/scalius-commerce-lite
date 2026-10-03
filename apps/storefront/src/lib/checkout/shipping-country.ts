/**
 * The shipping country at checkout and in the account address book
 * (MARKETS-DESIGN D7, step 3a). The store sells to the countries of its
 * active markets; a store that sells only to Bangladesh shows no country
 * field and keeps its City → Thana → Area form unchanged.
 *
 * Another country's address uses the generic fields (`FOREIGN_ADDRESS_FIELDS`),
 * server-rendered so the form works without JavaScript; with it, the
 * country's rules (`/address-rules/{countryCode}`) hide the fields it does
 * not use and mark the ones it requires. The API checks every address
 * against its country's rules. Until shipping zones by country (step 3b),
 * only Bangladesh has delivery rates: another country fails closed with
 * "we don't deliver there yet".
 */
import type { MarketMatrix } from "@scalius/shared/markets";

/** Bangladesh: City → Thana → Area, the delivery locations couriers book with. */
export const LOCATION_COUNTRY = "BD";

/** The order fields another country's address fills, in form order. */
export const FOREIGN_ADDRESS_FIELDS = [
  "shippingAddressLine2",
  "shippingDependentLocality",
  "shippingLocality",
  "shippingAdminArea",
  "shippingPostalCode",
] as const;
export type ForeignAddressField = (typeof FOREIGN_ADDRESS_FIELDS)[number];

/** The canonical address field each form field fills (the rules name these). */
export const FOREIGN_FIELD_RULE: Readonly<Record<ForeignAddressField, string>> = {
  shippingAddressLine2: "line2",
  shippingDependentLocality: "dependentLocality",
  shippingLocality: "locality",
  shippingAdminArea: "adminArea",
  shippingPostalCode: "postalCode",
};

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/** A posted or stored country: an ISO alpha-2 code, else Bangladesh. */
export function shippingCountryOf(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return COUNTRY_PATTERN.test(code) ? code : LOCATION_COUNTRY;
}

export function isLocationCountry(countryCode: string | null | undefined): boolean {
  return shippingCountryOf(countryCode) === LOCATION_COUNTRY;
}

/** The countries the store's active markets sell to, sorted; Bangladesh alone when none is listed. */
export function storeShippingCountries(matrix: MarketMatrix | null | undefined): string[] {
  const countries = new Set<string>();
  for (const market of matrix?.markets ?? []) {
    for (const country of market.countries) if (COUNTRY_PATTERN.test(country)) countries.add(country);
  }
  return countries.size > 0 ? [...countries].sort() : [LOCATION_COUNTRY];
}

/**
 * The country a form starts on: the page's market's first country (a
 * presence page sells to its market), else Bangladesh when the store sells
 * there, else the first country it sells to.
 */
export function defaultShippingCountry(
  matrix: MarketMatrix | null | undefined,
  presence: string | null | undefined,
  countries: readonly string[],
): string {
  const market = presence
    ? matrix?.markets.find((candidate) => candidate.presences.some((entry) => entry.value === presence))
    : null;
  const marketCountry = market?.countries.find((country) => countries.includes(country));
  if (marketCountry) return marketCountry;
  return countries.includes(LOCATION_COUNTRY) ? LOCATION_COUNTRY : countries[0] ?? LOCATION_COUNTRY;
}

/** A country's name in a language (`Intl.DisplayNames`), else its code. */
export function shippingCountryName(code: string, language = "en"): string {
  try {
    return new Intl.DisplayNames([language, "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const text = (value: unknown, max = 500): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed ? trimmed : null;
};

/** Another country's posted fields, trimmed (empty ones as null). */
export function readForeignAddressFields(read: (name: ForeignAddressField) => unknown): Record<ForeignAddressField, string | null> {
  return Object.fromEntries(FOREIGN_ADDRESS_FIELDS.map((field) => [field, text(read(field), 200)])) as Record<ForeignAddressField, string | null>;
}
