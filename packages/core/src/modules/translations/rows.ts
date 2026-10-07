// Reads at a presence (MARKETS-DESIGN D9): the columns a row statement
// folds in, and the step that turns them into the presence's text and
// handle. At the root nothing is folded and every row is returned as read,
// so a single-language store keeps its bytes.
import type { SQLWrapper } from "drizzle-orm";
import {
  applyTranslation,
  declareTranslated,
  foldedTranslationChain,
  localizedSlugSql,
  translationRowsSql,
  type TranslationScope,
} from "./fold";
import type { TranslatableResourceType } from "@scalius/shared/translations";

/** The folded columns of a translated row (stripped before it is presented). */
export interface TranslatedRowColumns {
  trRows?: string | null;
  trSlug?: string | null;
}

/**
 * The columns a presence read adds to a statement over one resource per row:
 * its translations and its presence-locale handle (types with handles).
 * None at the root.
 */
export function translationColumns(
  scope: TranslationScope | null,
  type: TranslatableResourceType,
  id: SQLWrapper,
  options: { slug?: boolean } = {},
) {
  if (!scope) return {};
  return {
    trRows: translationRowsSql(scope, type, id),
    ...(options.slug === false ? {} : { trSlug: localizedSlugSql(scope, type, id) }),
  };
}

/**
 * Rows in the presence's text: each field of `fields` (row key → translation
 * field) through the fallback chain, `slug` replaced by the presence-locale
 * handle when there is one, the folded columns removed. Declares
 * `tr:<type>:<id>` for every row. At the root the rows come back as read.
 */
export function translateRows<T extends { id: string } & TranslatedRowColumns>(
  scope: TranslationScope | null,
  type: TranslatableResourceType,
  rows: readonly T[],
  fields: Readonly<Record<string, string>>,
): Array<Omit<T, keyof TranslatedRowColumns>> {
  if (!scope) return rows as unknown as Array<Omit<T, keyof TranslatedRowColumns>>;
  declareTranslated(type, rows.map((row) => row.id));
  return rows.map(({ trRows, trSlug, ...row }) =>
    applyTranslation(row, foldedTranslationChain(scope, trRows), fields, trSlug ?? null));
}

/** One row (or null) in the presence's text. */
export function translateRow<T extends { id: string } & TranslatedRowColumns>(
  scope: TranslationScope | null,
  type: TranslatableResourceType,
  row: T | null | undefined,
  fields: Readonly<Record<string, string>>,
): Omit<T, keyof TranslatedRowColumns> | null {
  if (!row) return null;
  return translateRows(scope, type, [row], fields)[0]!;
}

/** A product card's translated text: its name (and handle). */
export const PRODUCT_CARD_FIELDS = { name: "name" } as const;
/** A product page's translated text. */
export const PRODUCT_PAGE_FIELDS = { name: "name", description: "description", metaTitle: "metaTitle", metaDescription: "metaDescription" } as const;
/** A category, brand or collection named on a card or a breadcrumb. */
export const NAME_FIELDS = { name: "name" } as const;
