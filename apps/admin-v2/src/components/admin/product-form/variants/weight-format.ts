import { formatUnit } from "@scalius/shared/locale-words";
import type { WeightUnit } from "@scalius/shared/store-defaults";
import { gramsToWeightUnit } from "@scalius/shared/weight-units";
import { dashboardNumberLocale } from "~/i18n";

const CLDR_WEIGHT_UNITS = { g: "gram", kg: "kilogram", oz: "ounce", lb: "pound" } as const;

/** A weight stored in grams, in the store's weight unit: "1,000 kg", "2,204.62 lb". */
export function formatWeight(grams: number, unit: WeightUnit): string {
  return formatUnit(gramsToWeightUnit(grams, unit) ?? 0, CLDR_WEIGHT_UNITS[unit], dashboardNumberLocale());
}
