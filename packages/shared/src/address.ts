/**
 * The canonical postal address (docs/MARKETS-DESIGN.md D7): one shape for
 * order shipping snapshots, the customer address book, checkout, the
 * dashboard and agents, validated by per-country rules.
 *
 * - Rules have Saleor's `addressValidationRules` shape (allowed and required
 *   fields, postal code pattern and examples, label types, field order) and
 *   come from libaddressinput. The table is server-side only
 *   (`@scalius/shared/address-metadata`); the API serves one country's rules
 *   at a time, so browser code imports only this module.
 * - Bangladesh keeps its courier-grade adapter beside the canonical fields:
 *   the City/Thana/Area delivery locations (ids and names). The adapter fills
 *   `locality` (city) and `dependentLocality` (thana) from the picked names.
 *   It never fills `adminArea`: a delivery location knows no division.
 * - The recipient's phone is E.164 (`customer-utils` parses it with the
 *   address country); this module never loads phone metadata.
 */
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "./markets";

/** The fields a country's rules can allow, require or order. */
export const ADDRESS_FIELDS = [
  "name",
  "company",
  "line1",
  "line2",
  "dependentLocality",
  "locality",
  "adminArea",
  "postalCode",
] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

/** How a country names its admin area (libaddressinput `state_name_type`). */
export type AdminAreaLabel =
  | "area" | "county" | "department" | "district" | "do_si" | "emirate" | "island"
  | "oblast" | "parish" | "prefecture" | "province" | "state";
/** How a country names its locality (`locality_name_type`). */
export type LocalityLabel = "city" | "district" | "post_town" | "suburb";
/** How a country names its dependent locality (`sublocality_name_type`). */
export type DependentLocalityLabel = "district" | "neighborhood" | "suburb" | "townland" | "village_township";
/** How a country names its postal code (`zip_name_type`). */
export type PostalCodeLabel = "eircode" | "pin" | "postal" | "zip";

export interface AddressAdminArea {
  /** What the address stores and a label prints (`CA`, `NSW`, `東京都`). */
  code: string;
  /** What a form shows (`California`, `New South Wales`, `Tokyo`). */
  name: string;
  /** ISO 3166-2 subdivision suffix when known (`CA`, `13`). */
  isoCode: string | null;
}

/** One country's address rules (Saleor's `addressValidationRules` shape). */
export interface AddressRules {
  countryCode: string;
  /** libaddressinput's format line: `%N` name, `%O` company, `%A` lines, `%D`, `%C`, `%S`, `%Z`, `%n` new line. */
  format: string;
  /** Form rows in the country's order; `line1` and `line2` are separate rows. */
  rows: AddressField[][];
  allowedFields: AddressField[];
  requiredFields: AddressField[];
  /** Fields a label prints in upper case. */
  upperFields: AddressField[];
  /** A whole-value, case-insensitive pattern, or null when any value is accepted. */
  postalCodePattern: string | null;
  postalCodeExamples: string[];
  labels: {
    adminArea: AdminAreaLabel;
    locality: LocalityLabel;
    dependentLocality: DependentLocalityLabel;
    postalCode: PostalCodeLabel;
  };
  /** The admin areas to choose from; empty means free text. */
  adminAreas: AddressAdminArea[];
}

/** Longest stored value of each text field. */
export const ADDRESS_FIELD_MAX_LENGTH: Readonly<Record<AddressField, number>> = {
  name: 100,
  company: 100,
  line1: 500,
  line2: 200,
  dependentLocality: 120,
  locality: 120,
  adminArea: 120,
  postalCode: 20,
};

/** What a form, an agent or the dashboard sends. Every field is optional text. */
export interface PostalAddressInput {
  countryCode?: string | null;
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  dependentLocality?: string | null;
  locality?: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
}

/** A normalized address (phone and the Bangladesh adapter are kept beside it). */
export interface PostalAddress {
  countryCode: string;
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  dependentLocality: string | null;
  locality: string | null;
  adminArea: string | null;
  postalCode: string | null;
  /** True when staff saved it although it breaks its country's rules (Saleor's flag). */
  validationSkipped: boolean;
}

export type AddressIssueCode = "required" | "invalid" | "too_long" | "unknown_country";

export interface AddressIssue {
  field: AddressField | "countryCode";
  code: AddressIssueCode;
}

export interface AddressValidationResult {
  address: PostalAddress;
  /** Empty when the address is valid (or saved with validation skipped). */
  issues: AddressIssue[];
}

/** Trimmed, whitespace collapsed (NFC); null when empty. */
export function normalizeAddressText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** A postal code as stored: upper case, single spaces. */
export function normalizePostalCode(value: string | null | undefined): string | null {
  return normalizeAddressText(value)?.toUpperCase() ?? null;
}

/** Whether a postal code matches a country's pattern (a missing pattern accepts anything). */
export function postalCodeMatches(rules: Pick<AddressRules, "postalCodePattern">, postalCode: string): boolean {
  if (!rules.postalCodePattern) return true;
  try {
    return new RegExp(`^(?:${rules.postalCodePattern})$`, "i").test(postalCode);
  } catch {
    return true;
  }
}

/** The admin area a value names (its code, name or ISO id, any case), or null. */
export function matchAdminArea(rules: Pick<AddressRules, "adminAreas">, value: string): AddressAdminArea | null {
  const wanted = value.trim().toLocaleLowerCase();
  return rules.adminAreas.find((area) =>
    area.code.toLocaleLowerCase() === wanted
    || area.name.toLocaleLowerCase() === wanted
    || (area.isoCode !== null && area.isoCode.toLocaleLowerCase() === wanted)) ?? null;
}

/**
 * Normalizes an address and checks it against its country's rules. Fields
 * the country does not use are dropped. A known admin area is stored as its
 * code. With `skipValidation` (staff only) the issues are still returned but
 * the address is kept as typed and marked `validationSkipped`; a too-long
 * value is never accepted.
 */
export function validatePostalAddress(
  input: PostalAddressInput,
  rules: AddressRules | null,
  options: { skipValidation?: boolean; ignore?: readonly AddressField[] } = {},
): AddressValidationResult {
  const countryCode = normalizeMarketCountry(input.countryCode) ?? "";
  const empty: PostalAddress = {
    countryCode,
    name: null, company: null, line1: null, line2: null,
    dependentLocality: null, locality: null, adminArea: null, postalCode: null,
    validationSkipped: false,
  };
  if (!rules || rules.countryCode !== countryCode) {
    return { address: empty, issues: [{ field: "countryCode", code: "unknown_country" }] };
  }
  const ignored = new Set(options.ignore ?? []);
  const allowed = new Set(rules.allowedFields);
  const issues: AddressIssue[] = [];
  const address: PostalAddress = { ...empty };
  for (const field of ADDRESS_FIELDS) {
    if (ignored.has(field)) continue;
    const value = field === "postalCode" ? normalizePostalCode(input[field]) : normalizeAddressText(input[field]);
    if (value !== null && value.length > ADDRESS_FIELD_MAX_LENGTH[field]) {
      issues.push({ field, code: "too_long" });
      continue;
    }
    if (!allowed.has(field)) continue;
    address[field] = value;
  }

  const ruleIssues: AddressIssue[] = [];
  for (const field of rules.requiredFields) {
    if (!ignored.has(field) && address[field] === null) ruleIssues.push({ field, code: "required" });
  }
  if (address.postalCode !== null && !postalCodeMatches(rules, address.postalCode)) {
    ruleIssues.push({ field: "postalCode", code: "invalid" });
  }
  if (address.adminArea !== null && rules.adminAreas.length > 0) {
    const area = matchAdminArea(rules, address.adminArea);
    if (area) address.adminArea = area.code;
    else ruleIssues.push({ field: "adminArea", code: "invalid" });
  }

  const tooLong = issues.length > 0;
  if (options.skipValidation && !tooLong && ruleIssues.length > 0) {
    return { address: { ...address, validationSkipped: true }, issues: [] };
  }
  return { address, issues: [...issues, ...ruleIssues] };
}

// ---------------------------------------------------------------------------
// The Bangladesh adapter
// ---------------------------------------------------------------------------

/** Bangladesh's delivery locations (City → Thana → Area): ids couriers book with, and their names. */
export interface DeliveryHierarchyLocation {
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
}

/** Whether a country's addresses use the City/Thana/Area adapter (Bangladesh). */
export function usesDeliveryHierarchy(countryCode: string | null | undefined): boolean {
  return (normalizeMarketCountry(countryCode) ?? DELIVERY_HIERARCHY_COUNTRY) === DELIVERY_HIERARCHY_COUNTRY;
}

/**
 * The canonical fields the adapter fills from the picked names: the city is
 * the locality and the thana the dependent locality. No admin area: the
 * delivery locations know no division, and none is invented.
 */
export function deliveryHierarchyCanonicalFields(location: Pick<DeliveryHierarchyLocation, "cityName" | "zoneName">): {
  countryCode: string;
  locality: string | null;
  dependentLocality: string | null;
} {
  return {
    countryCode: DELIVERY_HIERARCHY_COUNTRY,
    locality: normalizeAddressText(location.cityName),
    dependentLocality: normalizeAddressText(location.zoneName),
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Any stored address: canonical fields, optionally with the Bangladesh adapter. */
export type DisplayAddress = Partial<Pick<PostalAddress,
  "line1" | "line2" | "dependentLocality" | "locality" | "adminArea" | "postalCode">>
  & Partial<DeliveryHierarchyLocation>
  & { countryCode?: string | null };

/**
 * One line for lists, cards, invoices and messages. A Bangladesh address
 * reads as it always has (line, area, thana, city); another country reads
 * line, line 2, district, city, region, postal code and, when a resolver is
 * given, the country name.
 */
export function formatAddressInline(
  address: DisplayAddress,
  options: { countryName?: (code: string) => string } = {},
): string {
  const country = normalizeMarketCountry(address.countryCode);
  if (!country || country === DELIVERY_HIERARCHY_COUNTRY) {
    return [
      address.line1,
      address.line2,
      address.areaName ?? address.area,
      address.zoneName ?? address.zone ?? address.dependentLocality,
      address.cityName ?? address.city ?? address.locality,
      address.postalCode,
    ].filter((part): part is string => Boolean(part && part.trim())).join(", ");
  }
  return [
    address.line1,
    address.line2,
    address.dependentLocality,
    address.locality,
    [address.adminArea, address.postalCode].filter(Boolean).join(" "),
    options.countryName ? options.countryName(country) : country,
  ].filter((part): part is string => Boolean(part && part.trim())).join(", ");
}
