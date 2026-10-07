// Checkout and storefront copy per store language (MARKETS-DESIGN D9). The
// checkout copies (Settings → Checkout languages) are the text of the
// store's languages: a page reads the copy of its own language (a presence's
// locale; the root's is the store default language). The fallback chain is
// the translations' one: the merchant's copy of the language, else the
// built-in copy of that language (English, Bangla), else the default
// language's copy (the one in use at checkout), else English.
import { and, asc, desc, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { checkoutLanguages } from "@scalius/database/schema";
import {
  checkoutLanguageBaseCode,
  getCheckoutLanguagePreset,
  resolveCheckoutLanguageData,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { deps } from "../../cache-deps";

/** The built-in copies (`CHECKOUT_LANGUAGE_PRESETS`). */
const BUILT_IN_COPY_LOCALES: ReadonlySet<string> = new Set(["en", "bn"]);

/** The default store language: the root presence's locale. */
export const DEFAULT_STORE_LOCALE_SQL = sql`(SELECT default_presence.locale FROM market_presences AS default_presence
  WHERE default_presence.kind = 'subfolder' AND default_presence.value = '')`;

/** A page's locale as SQL: a presence's literal, else the store default language. */
export function pageLocaleSql(locale: string | null): SQL {
  return locale ? sql.raw(`'${/^[a-z]{2}$/.test(locale) ? locale : "en"}'`) : DEFAULT_STORE_LOCALE_SQL;
}

export interface CheckoutCopyRow {
  code: string;
  languageData: string;
  isActive: boolean;
  /** The page's locale (the store default language at the root). */
  pageLocale: string | null;
}

/**
 * The copies a page may read, best first: its language's, then the one in
 * use, then the fallback one (at most three rows, one statement). Declares
 * `lang` (the copies) and `tr:locales` (the default language).
 */
export function selectCheckoutCopyRows(db: Database, locale: string | null) {
  deps.checkoutLanguages();
  deps.translationLocales();
  const pageLocale = pageLocaleSql(locale);
  const ownLanguage = sql`lower(substr(${checkoutLanguages.code}, 1, 2)) = ${pageLocale}`;
  return db
    .select({
      code: checkoutLanguages.code,
      languageData: checkoutLanguages.languageData,
      isActive: checkoutLanguages.isActive,
      pageLocale: sql<string | null>`${pageLocale}`.as("page_locale"),
    })
    .from(checkoutLanguages)
    .where(and(
      isNull(checkoutLanguages.deletedAt),
      or(ownLanguage, sql`${checkoutLanguages.isActive} = 1`, sql`${checkoutLanguages.isDefault} = 1`),
    ))
    .orderBy(sql`${ownLanguage} DESC`, desc(checkoutLanguages.isActive), desc(checkoutLanguages.isDefault), asc(checkoutLanguages.id))
    .limit(3);
}

/** The copy a page reads, by the chain above (`locale`: a presence's; null at the root). */
export function pickCheckoutCopy(rows: readonly CheckoutCopyRow[], locale: string | null = null): { code: string; copy: CheckoutLanguageData } {
  locale ??= rows[0]?.pageLocale ?? null;
  const own = locale ? rows.find((row) => checkoutLanguageBaseCode(row.code) === locale) : undefined;
  if (own) return { code: own.code, copy: resolveCheckoutLanguageData(own.code, own.languageData) };
  if (locale && BUILT_IN_COPY_LOCALES.has(locale)) return { code: locale, copy: getCheckoutLanguagePreset(locale) };
  const fallback = rows[0];
  if (fallback) return { code: fallback.code, copy: resolveCheckoutLanguageData(fallback.code, fallback.languageData) };
  return { code: "en", copy: getCheckoutLanguagePreset("en") };
}

/** The copy of a page's language in one statement (the default language at the root). */
export async function readCheckoutCopyForLocale(db: Database, locale: string | null) {
  const rows = await selectCheckoutCopyRows(db, locale).all() as CheckoutCopyRow[];
  return pickCheckoutCopy(rows, locale);
}
