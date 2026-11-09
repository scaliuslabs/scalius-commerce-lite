// The one way the dashboard shows a record the platform created with a name
// (a migration's seed, or store setup naming the first market after its
// country): in the dashboard's language until the merchant renames it. Every
// seed with a literal name is listed here; seeded-names.test.ts reads the
// migrations and fails on one that isn't.
import { translate } from "~/i18n";
import { seededNameMessages } from "~/i18n/seeded-names";
import { countryName } from "./country-name";

interface SeededName {
  /** The table the seed writes. */
  table: string;
  id: string;
  /** The English name it is written with. */
  name: string;
  /** Named after a country (store setup renames the first market after the store's): shown as that country. */
  country?: boolean;
}

export const SEEDED_NAMES: readonly SeededName[] = [
  { table: "shipping_profiles", id: "shp_default", name: "General" },
  { table: "shipping_profiles", id: "shp_free_delivery", name: "Free delivery" },
  { table: "inventory_locations", id: "loc_default", name: "Main location" },
  { table: "markets", id: "mkt_backup", name: "Bangladesh", country: true },
  { table: "delivery_zones", id: "dz_bd", name: "Bangladesh", country: true },
];

/**
 * Seeds the dashboard already names by their id, or whose names merchants
 * never see as records (with why): the guard accepts these too.
 */
export const SEEDED_NAMES_NAMED_ELSEWHERE: Readonly<Record<string, string>> = {
  sales_channels: "Built-in channels are always named from salesChannelNamesMessages by id (channel.<id>).",
  navigation_menus: "Menus copied from the store's own earlier header and footer settings, in the merchant's words.",
  permissions: "Permissions are labelled from the dashboard's catalogues by key, never by their stored name.",
  places: "Place names are the country's own (Bangla and English both stored), not the platform's.",
  plugin_registrations: "An app's registrations carry the app's own names (its manifest translations).",
};

let byEnglishName: Map<string, string> | null = null;

/** The country an English country name is ("Bangladesh" → BD), from every region code Intl knows. */
function countryCodeOf(name: string): string | undefined {
  if (!byEnglishName) {
    byEnglishName = new Map();
    try {
      const names = new Intl.DisplayNames(["en"], { type: "region" });
      for (let first = 65; first <= 90; first += 1) {
        for (let second = 65; second <= 90; second += 1) {
          const code = String.fromCharCode(first, second);
          const english = names.of(code);
          if (english && english !== code && !byEnglishName.has(english)) byEnglishName.set(english, code);
        }
      }
    } catch {
      // No Intl regions: names stay as stored.
    }
  }
  return byEnglishName.get(name);
}

/**
 * A record's name as the dashboard shows it. A seeded record still carrying
 * its seeded name reads in the dashboard's language; any name the merchant
 * typed stays as they typed it; a seed named after a country (the first
 * market, a delivery zone) shows that country's name. Call it while rendering,
 * so a language switch renames it too.
 */
export function seededName(record: { id?: string | null; name: string }): string {
  // A name carried without its record's id (a stock movement, a timeline entry) is matched by the seeded name itself.
  const seed = record.id
    ? SEEDED_NAMES.find((entry) => entry.id === record.id)
    : SEEDED_NAMES.find((entry) => !entry.country && entry.name === record.name);
  if (!seed) return record.name;
  if (seed.country) {
    const code = countryCodeOf(record.name);
    return code ? countryName(code) : record.name;
  }
  return record.name === seed.name ? translate(seededNameMessages, seed.id as keyof (typeof seededNameMessages)["en"]) : record.name;
}

/**
 * The name to save from an editor that showed `seededName`: unchanged, the
 * stored name stays as it was (no save quietly rewrites it in one language).
 */
export function savedSeededName(record: { id?: string | null; name: string }, typed: string): string {
  return typed.trim() === seededName(record) ? record.name : typed.trim();
}
