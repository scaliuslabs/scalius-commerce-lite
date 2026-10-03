// Couriers state the countries they deliver to (MARKETS-DESIGN step 3a): the
// order page and the bulk dialog offer a courier only for orders shipping
// there, and say why the others are left out, so a booking never fails on it.
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";

export type CourierCountries = "any" | readonly string[];

/** Whether a courier delivers to the order's shipping country (an order without one ships in Bangladesh). */
export function courierServesCountry(countries: CourierCountries | undefined, countryCode: string | null | undefined): boolean {
  if (!countries || countries === "any") return true;
  return countries.includes(countryCode || DELIVERY_HIERARCHY_COUNTRY);
}

/** The couriers that deliver to the order's country, and those left out. */
export function couriersForCountry<P extends { countries?: CourierCountries }>(
  providers: readonly P[],
  countryCode: string | null | undefined,
): { served: P[]; elsewhere: P[] } {
  const served: P[] = [];
  const elsewhere: P[] = [];
  for (const provider of providers) (courierServesCountry(provider.countries, countryCode) ? served : elsewhere).push(provider);
  return { served, elsewhere };
}
