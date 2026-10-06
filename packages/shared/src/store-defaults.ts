// Store defaults (Settings → Store details → Store defaults, Shopify's card):
// the store time zone, the unit system and the default weight unit, their
// defaults and their validation. The platform settings (Worker entry, the
// dashboard's first chunk) read only this small module: the calendar math is
// ./commerce-time, gram conversions ./weight-units, and what a country implies
// for a new store ./store-country-defaults. Pure, browser-safe.

/**
 * The zone of a store that has not chosen one (and of every store before the
 * setting existed): Bangladesh, the launch market.
 */
export const DEFAULT_STORE_TIME_ZONE = "Asia/Dhaka";
/** IANA names are at most about 32 characters; this bounds stored input. */
export const TIME_ZONE_MAX_LENGTH = 64;

/** Whether `value` is an IANA time zone this runtime knows. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const zone = value.trim();
  if (!zone || zone.length > TIME_ZONE_MAX_LENGTH) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A stored or submitted zone, or the default when it is missing or unknown. */
export function normalizeTimeZone(value: unknown): string {
  return isValidTimeZone(value) ? value.trim() : DEFAULT_STORE_TIME_ZONE;
}

export const UNIT_SYSTEMS = ["metric", "imperial"] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export const WEIGHT_UNITS = ["g", "kg", "oz", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/** The weight units each system offers, its default first (Shopify's). */
export const SYSTEM_WEIGHT_UNITS: Readonly<Record<UnitSystem, readonly WeightUnit[]>> = {
  metric: ["kg", "g"],
  imperial: ["lb", "oz"],
};

/**
 * Before a store chose (every store before the setting existed): metric,
 * grams, as the dashboard always showed weights.
 */
export const DEFAULT_UNIT_SYSTEM: UnitSystem = "metric";
export const DEFAULT_WEIGHT_UNIT: WeightUnit = "g";

export function isUnitSystem(value: unknown): value is UnitSystem {
  return typeof value === "string" && (UNIT_SYSTEMS as readonly string[]).includes(value);
}

export function isWeightUnit(value: unknown): value is WeightUnit {
  return typeof value === "string" && (WEIGHT_UNITS as readonly string[]).includes(value);
}

export function normalizeUnitSystem(value: unknown): UnitSystem {
  return isUnitSystem(value) ? value : DEFAULT_UNIT_SYSTEM;
}

/** A weight unit of the system, else the system's default (a stored mismatch never shows lb in a metric store). */
export function normalizeWeightUnit(value: unknown, system: UnitSystem): WeightUnit {
  const units = SYSTEM_WEIGHT_UNITS[system];
  if (isWeightUnit(value) && units.includes(value)) return value;
  return system === DEFAULT_UNIT_SYSTEM && value === undefined ? DEFAULT_WEIGHT_UNIT : units[0]!;
}
