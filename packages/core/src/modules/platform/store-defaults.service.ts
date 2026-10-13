// Store defaults (Settings → Store details → Store defaults): the store's time
// zone, unit system and default weight unit. They live in the platform
// document so Worker entry resolves them with the origins (mirror first) and no
// request spends a database read on them (docs/STORE-DEFAULTS.md).
import type { Database } from "@scalius/database/client";
import { isValidTimeZone } from "@scalius/shared/commerce-time";
import type { PlatformConfig } from "@scalius/shared/platform-config";
import {
  SYSTEM_WEIGHT_UNITS,
  isUnitSystem,
  isWeightUnit,
  type UnitSystem,
  type WeightUnit,
} from "@scalius/shared/store-defaults";
import { ValidationError } from "@scalius/core/errors";
import type { SettingsStoreKv } from "../../settings-store";
import { readStoreCountry } from "../../utils/store-country";
import { platformDocument } from "./document";

export interface StoreDefaults {
  timeZone: string;
  unitSystem: UnitSystem;
  weightUnit: WeightUnit;
}

export type StoreDefaultsPatch = Partial<{ timeZone: string; unitSystem: string; weightUnit: string }>;

/** The store defaults of a platform configuration. */
export function storeDefaultsOf(config: Pick<PlatformConfig, "timeZone" | "unitSystem" | "weightUnit">): StoreDefaults {
  return { timeZone: config.timeZone, unitSystem: config.unitSystem, weightUnit: config.weightUnit };
}

/**
 * A validated document patch: a real IANA zone, a unit system, and a weight
 * unit of that system. Changing the system without a unit picks the system's
 * default unit (kilograms, pounds), as Shopify does.
 */
export function storeDefaultsPatch(current: StoreDefaults, patch: StoreDefaultsPatch): Partial<StoreDefaults> {
  const next: Partial<StoreDefaults> = {};
  if (patch.timeZone !== undefined) {
    const zone = patch.timeZone.trim();
    if (!isValidTimeZone(zone)) throw new ValidationError("Choose a time zone from the list, such as Europe/London.");
    next.timeZone = zone;
  }
  const system = patch.unitSystem === undefined ? current.unitSystem : patch.unitSystem;
  if (!isUnitSystem(system)) throw new ValidationError("Choose the metric or the imperial system.");
  if (patch.unitSystem !== undefined) next.unitSystem = system;
  const unit = patch.weightUnit ?? (system === current.unitSystem ? current.weightUnit : SYSTEM_WEIGHT_UNITS[system][0]);
  if (!isWeightUnit(unit) || !SYSTEM_WEIGHT_UNITS[system].includes(unit)) {
    throw new ValidationError(`Choose a weight unit of the ${system} system: ${SYSTEM_WEIGHT_UNITS[system].join(" or ")}.`);
  }
  if (unit !== current.weightUnit || patch.weightUnit !== undefined) next.weightUnit = unit;
  return next;
}

/** The stored store defaults and the platform revision a save must send back. */
export async function getStoreDefaults(db: Database): Promise<StoreDefaults & { revision: number }> {
  const { value, revision } = await platformDocument.readDetailed(db, {}, { skipCache: true });
  return { ...storeDefaultsOf(value), revision };
}

/**
 * The store defaults with the store's country (the backup market's), which
 * every staff screen formats numbers and dates and starts its weeks by.
 */
export async function getStoreFormatting(db: Database): Promise<StoreDefaults & { revision: number; countryCode: string | null }> {
  const [defaults, countryCode] = await Promise.all([getStoreDefaults(db), readStoreCountry(db)]);
  return { ...defaults, countryCode };
}

/** Saves a patch against the platform revision the editor loaded; the mirror is written through. */
export async function saveStoreDefaults(
  db: Database,
  patch: StoreDefaultsPatch,
  kv: SettingsStoreKv | null | undefined,
  options: { expectedRevision?: number } = {},
): Promise<StoreDefaults & { revision: number }> {
  const current = await getStoreDefaults(db);
  const saved = await platformDocument.write(db, storeDefaultsPatch(current, patch), { kv }, options);
  return { ...storeDefaultsOf(saved.value), revision: saved.revision };
}

