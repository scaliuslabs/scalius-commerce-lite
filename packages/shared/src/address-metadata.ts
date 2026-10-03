/**
 * Per-country address rules from the generated libaddressinput table
 * (`address-metadata.data.ts`, `pnpm generate:address-metadata`).
 *
 * Server-side only: the whole table stays in the API Worker, which serves
 * one country's rules at a time (`GET /api/v1/address-rules/{countryCode}`).
 * Browser bundles import `@scalius/shared/address` and never this module
 * (`scripts/check-source-policies.mjs` refuses it).
 */
import {
  ADDRESS_FIELDS,
  type AddressField,
  type AddressRules,
  type AdminAreaLabel,
  type DependentLocalityLabel,
  type LocalityLabel,
  type PostalCodeLabel,
} from "./address";
import { normalizeMarketCountry } from "./markets";
import {
  ADDRESS_METADATA,
  ADDRESS_METADATA_DEFAULTS,
  ADDRESS_METADATA_SOURCE,
  type CountryAddressMetadata,
} from "./address-metadata.data";

export { ADDRESS_METADATA_SOURCE };

/** libaddressinput format letters and the canonical field each fills (`%A` is both street lines). */
const FIELD_OF_LETTER: Readonly<Record<string, readonly AddressField[]>> = {
  N: ["name"],
  O: ["company"],
  A: ["line1", "line2"],
  D: ["dependentLocality"],
  C: ["locality"],
  S: ["adminArea"],
  Z: ["postalCode"],
};

/** Every country the table knows, sorted. Any other code is refused. */
export const ADDRESS_COUNTRY_CODES: readonly string[] = Object.freeze(Object.keys(ADDRESS_METADATA).sort());

const fieldsOfLetters = (letters: string): AddressField[] => {
  const fields = new Set<AddressField>();
  for (const letter of letters) for (const field of FIELD_OF_LETTER[letter] ?? []) fields.add(field);
  return ADDRESS_FIELDS.filter((field) => fields.has(field));
};

/** Form rows from a format line: one row per `%n` line, `%A` as two rows, literals and unknown letters dropped. */
export function addressRowsOfFormat(format: string): AddressField[][] {
  const rows: AddressField[][] = [];
  for (const line of format.split("%n")) {
    const letters = [...line.matchAll(/%([A-Za-z])/g)].map((match) => match[1]!);
    let row: AddressField[] = [];
    for (const letter of letters) {
      if (letter === "A") {
        if (row.length > 0) rows.push(row);
        rows.push(["line1"], ["line2"]);
        row = [];
        continue;
      }
      for (const field of FIELD_OF_LETTER[letter] ?? []) if (!row.includes(field)) row.push(field);
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

function rulesOf(countryCode: string, record: CountryAddressMetadata): AddressRules {
  const format = record.fmt ?? ADDRESS_METADATA_DEFAULTS.fmt;
  const rows = addressRowsOfFormat(format);
  const allowed = new Set(rows.flat());
  const required = fieldsOfLetters(record.require ?? ADDRESS_METADATA_DEFAULTS.require)
    // Only the first street line is ever required.
    .filter((field) => field !== "line2" && allowed.has(field));
  return {
    countryCode,
    format,
    rows,
    allowedFields: ADDRESS_FIELDS.filter((field) => allowed.has(field)),
    requiredFields: required,
    upperFields: fieldsOfLetters(record.upper ?? ADDRESS_METADATA_DEFAULTS.upper).filter((field) => allowed.has(field)),
    postalCodePattern: record.zip ?? null,
    postalCodeExamples: record.zipex ? record.zipex.split(",").map((example) => example.trim()).filter(Boolean) : [],
    labels: {
      adminArea: (record.state_name_type ?? ADDRESS_METADATA_DEFAULTS.state_name_type) as AdminAreaLabel,
      locality: (record.locality_name_type ?? ADDRESS_METADATA_DEFAULTS.locality_name_type) as LocalityLabel,
      dependentLocality: (record.sublocality_name_type ?? ADDRESS_METADATA_DEFAULTS.sublocality_name_type) as DependentLocalityLabel,
      postalCode: (record.zip_name_type ?? ADDRESS_METADATA_DEFAULTS.zip_name_type) as PostalCodeLabel,
    },
    adminAreas: (record.areas ?? []).map(([code, name, isoCode]) => ({ code, name, isoCode: isoCode ?? null })),
  };
}

const cache = new Map<string, AddressRules>();

/** One country's rules, or null for a code the table does not know (refused everywhere). */
export function addressRulesFor(countryCode: string | null | undefined): AddressRules | null {
  const code = normalizeMarketCountry(countryCode);
  if (!code) return null;
  const record = ADDRESS_METADATA[code];
  if (!record) return null;
  let rules = cache.get(code);
  if (!rules) {
    rules = rulesOf(code, record);
    cache.set(code, rules);
  }
  return rules;
}

/** Countries whose rules require a field: the per-country shipping-address trigger is generated from these. */
export function countriesRequiringAddressField(field: Extract<AddressField, "locality" | "dependentLocality" | "adminArea" | "postalCode">): string[] {
  return ADDRESS_COUNTRY_CODES.filter((code) => addressRulesFor(code)!.requiredFields.includes(field));
}

/**
 * An address as printed lines in its country's format (labels, invoices):
 * literals kept, empty fields and lines dropped, upper-case fields upper-cased.
 */
export function formatAddressLines(
  address: Partial<Record<AddressField, string | null>>,
  rules: Pick<AddressRules, "format" | "upperFields">,
): string[] {
  const upper = new Set(rules.upperFields);
  const valueOf = (letter: string): string => {
    const fields = FIELD_OF_LETTER[letter] ?? [];
    return fields
      .map((field) => {
        const value = address[field]?.trim() ?? "";
        return upper.has(field) ? value.toLocaleUpperCase() : value;
      })
      .filter(Boolean)
      .join("\n");
  };
  const lines: string[] = [];
  for (const line of rules.format.split("%n")) {
    const tokens = line.split(/(%[A-Za-z])/).filter((token) => token !== "");
    const hasValue = tokens.some((token) => token.startsWith("%") && valueOf(token.slice(1)) !== "");
    if (!hasValue) continue;
    // A literal next to an empty field is dropped with it (", " before a missing region).
    let text = "";
    tokens.forEach((token, index) => {
      if (token.startsWith("%")) {
        text += valueOf(token.slice(1));
        return;
      }
      const before = tokens[index - 1];
      const after = tokens[index + 1];
      const keep = (before === undefined || !before.startsWith("%") || valueOf(before.slice(1)) !== "")
        && (after === undefined || !after.startsWith("%") || valueOf(after.slice(1)) !== "");
      if (keep) text += token;
    });
    for (const part of text.split("\n")) {
      const trimmed = part.trim().replace(/^[,\-–\s]+|[,\-–\s]+$/g, "");
      if (trimmed) lines.push(trimmed);
    }
  }
  return lines;
}
