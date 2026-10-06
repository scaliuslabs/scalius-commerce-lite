// Weights in the store's unit. Weights are stored in grams everywhere
// (`product_variants.weight`); only the dashboard shows and accepts them in
// the store's default weight unit (./store-defaults). Pure, browser-safe.
import type { WeightUnit } from "./store-defaults";

/** Grams per unit: exact definitions (1 lb = 453.59237 g, 1 oz = 1/16 lb). */
const GRAMS_PER_UNIT: Readonly<Record<WeightUnit, number>> = {
  g: 1,
  kg: 1000,
  lb: 453.59237,
  oz: 28.349523125,
};

/** Digits a weight shows in each unit: enough to round-trip a gram. */
const WEIGHT_DIGITS: Readonly<Record<WeightUnit, number>> = { g: 2, kg: 5, lb: 4, oz: 3 };

/** A stored gram weight in the store's unit, rounded for display; null stays null. */
export function gramsToWeightUnit(grams: number | null | undefined, unit: WeightUnit): number | null {
  if (grams === null || grams === undefined || !Number.isFinite(grams)) return null;
  const factor = 10 ** WEIGHT_DIGITS[unit];
  return Math.round((grams / GRAMS_PER_UNIT[unit]) * factor) / factor;
}

/**
 * A weight entered in the store's unit as grams, to a hundredth of a gram so
 * an unchanged value reads back as entered.
 */
export function weightUnitToGrams(value: number | null | undefined, unit: WeightUnit): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * GRAMS_PER_UNIT[unit] * 100) / 100;
}
