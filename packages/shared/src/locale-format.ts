// The one formatting layer: numbers, money amounts, dates, times, relative
// times, lists, plurals and units, through `Intl` for a locale built from the
// reader's language and the store's country (CLDR data, as browsers and
// Workers ship it), and the text direction, which Intl does not give every
// browser.
// Pure, browser-safe and host-locale independent: the host's own locale and
// zone are never consulted. `scripts/check-source-policies.mjs` keeps Intl
// formatters out of every other file. Lists, plurals, relative times and
// units are ./locale-words, money amounts ./money-format and the first day of
// the week ./week-start, so the dashboard's first chunk carries only what every
// screen needs.

/** The store country before the store chose one (every store before Markets): Bangladesh. */
export const DEFAULT_STORE_REGION = "BD";

/**
 * A right-to-left pseudo-locale (ICU's `ar-XB`) for tests only: no catalog
 * has it, but direction and formatting treat it as the right-to-left locale
 * it stands for.
 */
export const RTL_PSEUDO_LOCALE = "ar-XB";

/** "bn" of "bn-BD", "bn_BD" or "BN"; "en" for anything that is not a language. */
export function baseLanguage(value: unknown): string {
  const language = String(value ?? "").trim().split(/[-_]/)[0]!.toLowerCase();
  return /^[a-z]{2,3}$/.test(language) ? language : "en";
}

/** An ISO 3166-1 alpha-2 country as stored ("BD"), else null. */
function regionOf(value: string | null | undefined): string | null {
  return value && /^[A-Z]{2}$/.test(value) ? value : null;
}

/** The locale dates are written in: the language in the store's country (`en-BD`: "Oct 7, 2026"; Bangla `bn-BD`). */
export function dateLocale(language: string, region?: string | null): string {
  const lang = baseLanguage(language);
  const country = regionOf(region) ?? (lang === "bn" ? "BD" : null);
  return country ? `${lang}-${country}` : lang;
}

/**
 * The locale numbers are written in: the language in the store's country.
 * CLDR has no English for Bangladesh, which groups in lakhs (12,34,567) as
 * India does, so English there is `en-IN`. Bangla is `bn-BD` (Bangla digits)
 * unless the store is elsewhere (`bn-IN`).
 */
export function numberLocale(language: string, region?: string | null): string {
  const tag = dateLocale(language, region);
  return tag === "en-BD" ? "en-IN" : tag;
}

// Building an Intl formatter is the expensive part: one per locale and
// options. A pure memo of immutable formatters, never merchant state; bounded.
const CACHE_LIMIT = 256;
const cache = /* @__PURE__ */ new Map<string, unknown>();

/** One immutable Intl formatter per kind, locale and options (./locale-words builds its own through it). */
export function cachedFormatter<T>(kind: string, locale: string, options: object | undefined, build: (locale: string) => T): T {
  const key = kind + locale + JSON.stringify(options);
  let found = cache.get(key) as T | undefined;
  if (found === undefined) {
    // Tags come from numberLocale/dateLocale, which only build well-formed ones;
    // a language the runtime lacks falls back inside Intl.
    found = build(locale);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, found);
  }
  return found;
}

export function numberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFormatter("number", locale, options, (tag) => new Intl.NumberFormat(tag, options));
}

export function dateTimeFormatter(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedFormatter("date", locale, options, (tag) => new Intl.DateTimeFormat(tag, options));
}

export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return numberFormatter(locale, options).format(value);
}

/** An instant in `options.timeZone` (callers pass the store's zone). */
export function formatDateTime(value: Date | number, locale: string, options?: Intl.DateTimeFormatOptions): string {
  return dateTimeFormatter(locale, options).format(value);
}

// ---------------------------------------------------------------------------
// Text direction
// ---------------------------------------------------------------------------

/** Languages written right to left (CLDR `characterOrder`), the test pseudo-locale included. */
const RTL_LANGUAGES = /^(?:ar|arc|ckb|dv|fa|he|ks|ps|sd|syr|ug|ur|yi)$/;

/** "rtl" for Arabic, Hebrew, Persian, Urdu and the other right-to-left languages, else "ltr". */
export function textDirection(language: unknown): "ltr" | "rtl" {
  return RTL_LANGUAGES.test(baseLanguage(language)) ? "rtl" : "ltr";
}
