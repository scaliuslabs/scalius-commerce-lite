/**
 * Builds one compact location string without repeating structured city/zone
 * values already present in a merchant-entered street address.
 */
export function formatLocationParts(
  ...values: Array<string | null | undefined>
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const segment of value?.split(",") ?? []) {
      const display = segment.trim().replace(/\s+/g, " ");
      const identity = display.toLocaleLowerCase("en-US");
      if (!display || seen.has(identity)) continue;
      seen.add(identity);
      parts.push(display);
    }
  }

  return parts.join(", ");
}

/** An address as stored: canonical fields beside Bangladesh's City/Thana/Area names. */
export interface PresentedAddress {
  countryCode?: string | null;
  line1?: string | null;
  line2?: string | null;
  dependentLocality?: string | null;
  locality?: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
  cityName?: string | null;
  zoneName?: string | null;
  areaName?: string | null;
}

const isBangladesh = (countryCode: string | null | undefined) => !countryCode || countryCode === "BD";

/**
 * An address as lines for a card: the street lines, then the places
 * (Bangladesh: area, thana, city, as it always read; elsewhere: district,
 * city, region and postal code), then the country outside Bangladesh.
 */
export function formatAddressLines(address: PresentedAddress, countryName: (code: string) => string): string[] {
  const street = formatLocationParts(address.line1, address.line2);
  const places = isBangladesh(address.countryCode)
    ? formatLocationParts(address.areaName, address.zoneName, address.cityName ?? address.locality, address.postalCode)
    : formatLocationParts(
      address.dependentLocality,
      address.locality,
      [address.adminArea, address.postalCode].filter(Boolean).join(" "),
    );
  const country = isBangladesh(address.countryCode) ? "" : countryName(address.countryCode!);
  return [street, places, country].filter(Boolean);
}

/** The order's shipping snapshot in one line (a Bangladesh address reads as before). */
export function formatShippingAddress(
  order: PresentedAddress & { shippingAddress?: string | null; shippingAddressLine2?: string | null; shippingCountryCode?: string | null;
    shippingDependentLocality?: string | null; shippingLocality?: string | null; shippingAdminArea?: string | null; shippingPostalCode?: string | null },
  countryName: (code: string) => string,
): string {
  if (isBangladesh(order.shippingCountryCode)) {
    return formatLocationParts(order.shippingAddress, order.shippingAddressLine2, order.areaName, order.zoneName, order.cityName, order.shippingPostalCode);
  }
  return formatAddressLines({
    countryCode: order.shippingCountryCode,
    line1: order.shippingAddress,
    line2: order.shippingAddressLine2,
    dependentLocality: order.shippingDependentLocality,
    locality: order.shippingLocality,
    adminArea: order.shippingAdminArea,
    postalCode: order.shippingPostalCode,
  }, countryName).join(", ");
}
