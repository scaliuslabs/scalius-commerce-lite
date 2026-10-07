// The store's languages (MARKETS-DESIGN D9; Shopify's Settings → Languages):
// one list, `store_languages`. The default language is the backup market's
// root presence locale; a presence names a store language, and only a
// published language's presences are served. The database keeps the rules
// (STORE_LANGUAGE_REQUIRED, STORE_LANGUAGE_DEFAULT_REQUIRED,
// STORE_LANGUAGE_IN_USE); this service turns them into merchant-facing errors.
import { and, asc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { BACKUP_MARKET_ID, checkoutLanguages, marketPresences, storeLanguages, translations } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { MAX_STORE_LANGUAGES, isStoreLocale } from "@scalius/shared/translations";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** At most this many languages, published or not. */
export const MAX_STORE_LANGUAGE_ROWS = 50;

export interface StoreLanguage {
  locale: string;
  published: boolean;
  /** The default language: the root presence's (the backup market at the store's own URL). */
  isDefault: boolean;
  /** The subfolders that show pages in it (`en-in`; the root is `''`). */
  presences: string[];
  /** How many resources have a translation in it (every market). */
  translatedResources: number;
}

function languageError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  if (/STORE_LANGUAGE_IN_USE/.test(text)) return new ConflictError("A market's web address uses this language. Change that market's language first.");
  if (/STORE_LANGUAGE_DEFAULT_REQUIRED/.test(text)) return new ValidationError("The default language is always published. Choose another default language first.");
  if (/STORE_LANGUAGE_REQUIRED/.test(text)) return new ValidationError("Add the language to the store and publish it first.");
  if (/UNIQUE|PRIMARY|duplicate/i.test(text) && /store_languages/i.test(text)) return new ConflictError("The store already has this language.");
  return error;
}

function cleanLocale(locale: string): string {
  const value = locale.trim().toLowerCase();
  if (!isStoreLocale(value)) throw new ValidationError("Choose a language by its two-letter code, such as bn or en.");
  return value;
}

/** Every store language, the default first, then by code. */
export async function listStoreLanguages(db: Database): Promise<StoreLanguage[]> {
  const [languageRows, presenceRows, countRows] = await Promise.all([
    db.select({ locale: storeLanguages.locale, published: storeLanguages.published }).from(storeLanguages).orderBy(asc(storeLanguages.locale)),
    db.select({ value: marketPresences.value, locale: marketPresences.locale }).from(marketPresences)
      .where(eq(marketPresences.kind, "subfolder")).orderBy(asc(marketPresences.value)),
    db.select({
      locale: translations.locale,
      count: sql<number>`count(DISTINCT ${translations.resourceType} || ':' || ${translations.resourceId})`,
    }).from(translations).groupBy(translations.locale),
  ]);
  const defaultLocale = presenceRows.find((row) => row.value === "")?.locale ?? null;
  return languageRows.map((row) => ({
    locale: row.locale,
    published: Boolean(row.published),
    isDefault: row.locale === defaultLocale,
    presences: presenceRows.filter((presence) => presence.locale === row.locale).map((presence) => presence.value),
    translatedResources: Number(countRows.find((count) => count.locale === row.locale)?.count ?? 0),
  })).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || (left.locale < right.locale ? -1 : 1));
}

/** The default language: the root presence's locale ("en" before any market exists). */
export async function readDefaultStoreLanguage(db: Database): Promise<string> {
  const row = await db.select({ locale: marketPresences.locale }).from(marketPresences)
    .where(and(eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, "")))
    .get();
  return row?.locale ?? "en";
}

async function getStoreLanguage(db: Database, locale: string): Promise<StoreLanguage> {
  const language = (await listStoreLanguages(db)).find((each) => each.locale === locale);
  if (!language) throw new NotFoundError("The store has no such language.");
  return language;
}

async function assertLimits(db: Database, change: { adding: boolean; publishing: boolean }): Promise<void> {
  const [row] = await db.select({
    total: sql<number>`count(*)`,
    published: sql<number>`coalesce(sum(CASE WHEN ${storeLanguages.published} = 1 THEN 1 ELSE 0 END), 0)`,
  }).from(storeLanguages);
  if (change.adding && Number(row?.total ?? 0) >= MAX_STORE_LANGUAGE_ROWS) {
    throw new ValidationError(`A store has at most ${MAX_STORE_LANGUAGE_ROWS} languages. Remove one you don't use first.`);
  }
  if (change.publishing && Number(row?.published ?? 0) >= MAX_STORE_LANGUAGES) {
    throw new ValidationError(`A store publishes at most ${MAX_STORE_LANGUAGES} languages. Unpublish one first.`);
  }
}

/** Adds a language (unpublished unless asked): translate first, then publish. */
export async function addStoreLanguage(db: Database, input: { locale: string; published?: boolean }): Promise<StoreLanguage> {
  const locale = cleanLocale(input.locale);
  await assertLimits(db, { adding: true, publishing: input.published === true });
  try {
    await db.insert(storeLanguages).values({ locale, published: input.published === true });
  } catch (error) {
    throw languageError(error);
  }
  return getStoreLanguage(db, locale);
}

/** Publishes or unpublishes a language. Its presences are served only while it is published. */
export async function setStoreLanguagePublished(db: Database, locale: string, published: boolean): Promise<StoreLanguage> {
  const current = await getStoreLanguage(db, cleanLocale(locale));
  if (current.published === published) return current;
  if (published) await assertLimits(db, { adding: false, publishing: true });
  try {
    await db.update(storeLanguages)
      .set({ published, updatedAt: sql`unixepoch()` })
      .where(eq(storeLanguages.locale, current.locale));
  } catch (error) {
    throw languageError(error);
  }
  return getStoreLanguage(db, current.locale);
}

/** Removes a language with its translations and localized handles. A market's web address must not use it. */
export async function removeStoreLanguage(db: Database, locale: string): Promise<void> {
  const current = await getStoreLanguage(db, cleanLocale(locale));
  if (current.presences.length > 0) throw languageError(new Error("STORE_LANGUAGE_IN_USE"));
  try {
    await db.delete(storeLanguages).where(eq(storeLanguages.locale, current.locale));
  } catch (error) {
    throw languageError(error);
  }
}

/**
 * Makes a language the default: the root presence's locale (published if it
 * was not). The checkout copy buyers read at the root follows: the copy of
 * that language, preferring the one in use at checkout (`is_active` moves to
 * it when one exists).
 */
export async function setDefaultStoreLanguage(db: Database, locale: string): Promise<StoreLanguage> {
  const current = await getStoreLanguage(db, cleanLocale(locale));
  if (current.isDefault) return current;
  if (!current.published) await assertLimits(db, { adding: false, publishing: true });
  try {
    await safeBatch(db, [
      ...ensureStoreLanguageWrites(db, [current.locale], { publish: true }),
      db.update(marketPresences).set({ locale: current.locale })
        .where(and(eq(marketPresences.marketId, BACKUP_MARKET_ID), eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, ""))),
      ...checkoutCopyFollowsDefaultWrites(db, current.locale),
    ] as never);
  } catch (error) {
    throw languageError(error);
  }
  return getStoreLanguage(db, current.locale);
}

/**
 * Writes that make each locale a store language before a presence names it:
 * a new one is added published (a market's web address is meant to be
 * served); `publish` also publishes an existing one (the root's language).
 */
export function ensureStoreLanguageWrites(db: Database, locales: readonly string[], options: { publish?: boolean } = {}): SQLiteBatchItem[] {
  return [...new Set(locales.map(cleanLocale))].map((locale) => {
    const insert = db.insert(storeLanguages).values({ locale, published: true });
    return (options.publish
      ? insert.onConflictDoUpdate({ target: storeLanguages.locale, set: { published: true, updatedAt: sql`unixepoch()` } })
      : insert.onConflictDoNothing({ target: storeLanguages.locale })) as unknown as SQLiteBatchItem;
  });
}

/**
 * The checkout copy in use (`is_active`) moves to the new default language's
 * copy, when the store has one; otherwise it stays (the read picks the copy
 * by language first, so the root shows the default language's copy anyway).
 */
export function checkoutCopyFollowsDefaultWrites(db: Database, locale: string): SQLiteBatchItem[] {
  const hasCopy = sql`EXISTS (SELECT 1 FROM ${checkoutLanguages} AS default_copy WHERE default_copy.deleted_at IS NULL AND lower(substr(default_copy.code, 1, 2)) = ${locale})`;
  return [
    db.update(checkoutLanguages).set({ isActive: false })
      .where(and(eq(checkoutLanguages.isActive, true), hasCopy)) as unknown as SQLiteBatchItem,
    db.update(checkoutLanguages).set({ isActive: true })
      .where(sql`${checkoutLanguages.id} = (SELECT chosen_copy.id FROM ${checkoutLanguages} AS chosen_copy
        WHERE chosen_copy.deleted_at IS NULL AND lower(substr(chosen_copy.code, 1, 2)) = ${locale}
        ORDER BY chosen_copy.is_default DESC, chosen_copy.id LIMIT 1)`) as unknown as SQLiteBatchItem,
  ];
}
