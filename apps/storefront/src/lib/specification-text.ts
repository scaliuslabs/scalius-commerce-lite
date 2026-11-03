// A specification's value as a buyer reads it. A number attribute's value is
// stored as canonical text ("15.6 inch": ASCII digits, a "." decimal) and
// travels as data that way (the API, `product.specifications` and card
// `keySpecs` for app skins). The page writes the number itself in its own
// digits and decimal sign ("১৫.৬ inch" on a Bangla page), ungrouped like the
// stored text (a model year stays "২০২৪"), with its unit; any other value
// shows as stored.
import { formatNumber, numberLocale } from "@scalius/shared/locale-format";
import { pageLanguage, storeRegion } from "./store-time-zone";

export interface SpecificationValue {
  value: string;
  unit: string | null;
  /** A number attribute's number; null or absent for any other attribute. */
  number?: number | null;
}

/** The value in the page's digits (a number with its unit), else as stored. */
export function specificationText(row: SpecificationValue, language: string = pageLanguage()): string {
  if (typeof row.number !== "number" || !Number.isFinite(row.number)) return row.value;
  const number = formatNumber(row.number, numberLocale(language || "en", storeRegion()), { maximumFractionDigits: 6, useGrouping: false });
  return row.unit ? `${number} ${row.unit}` : number;
}
