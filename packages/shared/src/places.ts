/**
 * The place directory (docs/PLACES.md): the delivery places of any country,
 * as a tree of numbered levels. Browser safe: the dashboard, the API and the
 * plugin SDK read the same levels, labels and dataset shape.
 *
 * - A place has a country, a level (1 is the top) and a parent one level up.
 * - Each country names its levels once, here (English and Bangla). A country
 *   without its own names uses the generic ones.
 * - Bangladesh addresses keep their City/Thana/Area adapter fields (`city`,
 *   `zone`, `area`): `deliveryHierarchyField()` maps a level to its field.
 * - A dataset (`data/places/<country>/`) is the source of imported places:
 *   one `PlaceDatasetEntry` per place, keyed by a stable source `key`.
 */

/** The deepest level a place can have. */
export const PLACE_MAX_LEVEL = 4;
/** The longest place name, after whitespace is collapsed. */
export const PLACE_NAME_MAX_LENGTH = 120;
/** A stable source key, for example `pathao:area:13193`. */
export const PLACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
/** A dataset id, for example `bd`: the source of the places an import creates. */
export const PLACE_SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** The most places one import call takes (D1: one bound JSON parameter per statement). */
export const PLACE_IMPORT_MAX_ENTRIES = 500;

/** The name of one level, in the dashboard's languages. */
export interface PlaceLevelName {
  readonly en: string;
  readonly enPlural: string;
  readonly bn: string;
}

const level = (en: string, enPlural: string, bn: string): PlaceLevelName => Object.freeze({ en, enPlural, bn });

/** The level names of a country without its own: up to `PLACE_MAX_LEVEL` levels. */
export const GENERIC_PLACE_LEVELS: readonly PlaceLevelName[] = Object.freeze([
  level("Region", "Regions", "অঞ্চল"),
  level("City", "Cities", "শহর"),
  level("District", "Districts", "জেলা"),
  level("Area", "Areas", "এলাকা"),
]);

/** Countries that name their own levels; the list length is the country's depth. */
export const PLACE_LEVELS: Readonly<Record<string, readonly PlaceLevelName[]>> = Object.freeze({
  BD: Object.freeze([
    level("City", "Cities", "শহর"),
    level("Thana", "Thanas", "থানা"),
    level("Area", "Areas", "এলাকা"),
  ]),
});

/** A country's levels, top first (index 0 is level 1). */
export function placeLevels(countryCode: string | null | undefined): readonly PlaceLevelName[] {
  const code = typeof countryCode === "string" ? countryCode.trim().toUpperCase() : "";
  return PLACE_LEVELS[code] ?? GENERIC_PLACE_LEVELS;
}

/** Whether `value` is a level the country has. */
export function isPlaceLevel(countryCode: string | null | undefined, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= placeLevels(countryCode).length;
}

/** One level's name in a dashboard language (`plural` for a list heading). */
export function placeLevelName(
  countryCode: string | null | undefined,
  placeLevel: number,
  locale: string,
  options: { plural?: boolean } = {},
): string {
  const names = placeLevels(countryCode);
  const name = names[Math.min(Math.max(placeLevel, 1), names.length) - 1]!;
  if (locale.startsWith("bn")) return name.bn;
  return options.plural ? name.enPlural : name.en;
}

// ---------------------------------------------------------------------------
// The Bangladesh adapter: address fields by level
// ---------------------------------------------------------------------------

export {
  DELIVERY_HIERARCHY_FIELDS,
  PLACE_ADDRESS_COUNTRY,
  deliveryHierarchyField,
  deliveryHierarchyLevel,
  type DeliveryHierarchyField,
} from "./place-fields";

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/** One place of a dataset (one line of `places.json`). */
export interface PlaceDatasetEntry {
  /** Stable source key, unique in the country. */
  key: string;
  level: number;
  /** The parent's key; null for level 1. */
  parent: string | null;
  name: string;
  /** Courier ids of the place, by courier (`{ "pathao": "32" }`). */
  externalIds: Record<string, string>;
  /** Whether the source still serves the place. */
  active: boolean;
  homeDelivery?: boolean;
  pickup?: boolean;
  /** The place's row id in stores set up before the dataset existed. */
  legacyId?: string;
}

/** `manifest.json` of a dataset. */
export interface PlaceDatasetManifest {
  /** The dataset id: the source of the places its import creates. */
  id: string;
  country: string;
  source: string;
  exportedAt: string;
  levels: Array<{ level: number; label: { en: string; bn: string } }>;
  counts: Record<string, number>;
  inactive: number;
  /** SHA-256 of `places.json`: the dataset version. */
  sha256: string;
}

const ENTRY_FIELDS = ["key", "level", "parent", "name", "externalIds", "active", "homeDelivery", "pickup", "legacyId"] as const;

/** Code-unit order, so every runtime sorts a dataset the same way. */
const byCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Dataset order: level, then parent key, then lower-case name, then key. */
export function sortPlaceDataset(entries: readonly PlaceDatasetEntry[]): PlaceDatasetEntry[] {
  return [...entries].sort((left, right) =>
    left.level - right.level
    || byCodeUnits(left.parent ?? "", right.parent ?? "")
    || byCodeUnits(left.name.toLowerCase(), right.name.toLowerCase())
    || byCodeUnits(left.key, right.key));
}

/**
 * `places.json` text: one place per line, in dataset order, with a stable
 * field order, so a refreshed dataset reads as a line diff.
 */
export function serializePlaceDataset(entries: readonly PlaceDatasetEntry[]): string {
  const lines = sortPlaceDataset(entries).map((entry) => {
    const ordered: Record<string, unknown> = {};
    for (const field of ENTRY_FIELDS) {
      const value = entry[field];
      if (value === undefined) continue;
      ordered[field] = field === "externalIds"
        ? Object.fromEntries(Object.entries(value as Record<string, string>).sort(([a], [b]) => byCodeUnits(a, b)))
        : value;
    }
    return JSON.stringify(ordered);
  });
  return `[\n${lines.join(",\n")}\n]\n`;
}

/** The counts a manifest states: places per level and inactive places. */
export function placeDatasetCounts(entries: readonly PlaceDatasetEntry[]): { counts: Record<string, number>; inactive: number } {
  const counts: Record<string, number> = {};
  let inactive = 0;
  for (const entry of entries) {
    counts[String(entry.level)] = (counts[String(entry.level)] ?? 0) + 1;
    if (!entry.active) inactive += 1;
  }
  return { counts, inactive };
}
