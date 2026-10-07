// The first day of the week in a country (CLDR supplemental `weekData`):
// date pickers start their weeks on it and reports bucket "week" rows from it.
// Not every browser has `Intl.Locale#getWeekInfo`, so the table is here.
// Pure, browser-safe.
import { baseLanguage } from "./locale-format";

/** Day numbers as `Date#getDay` counts them: 0 is Sunday. */
export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// `weekData/firstDay`: every territory not listed starts on Monday ("001").
const FIRST_DAY_SUNDAY = new Set(
  ("AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN IS JM JP KE KH KR LA MH MM MO MT MX MZ NI NP "
    + "PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW").split(" "),
);
const FIRST_DAY_SATURDAY = new Set("AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "));
const FIRST_DAY_FRIDAY = new Set(["MV"]);

/**
 * The first day of the week in a country (CLDR). Without a country, the
 * language's likely country: English is the US's (Sunday), Bangla
 * Bangladesh's (Sunday).
 */
export function weekStartDay(region: string | null | undefined, language = "en"): WeekDay {
  const code = region?.trim().toUpperCase() ?? "";
  const country = /^[A-Z]{2}$/.test(code) ? code : likelyRegion(language);
  if (FIRST_DAY_SUNDAY.has(country)) return 0;
  if (FIRST_DAY_SATURDAY.has(country)) return 6;
  if (FIRST_DAY_FRIDAY.has(country)) return 5;
  return 1;
}

function likelyRegion(language: string): string {
  try {
    return new Intl.Locale(baseLanguage(language)).maximize().region ?? "001";
  } catch {
    return "001";
  }
}
