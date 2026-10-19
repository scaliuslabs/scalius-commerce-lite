// Translations at read time (MARKETS-DESIGN D9, "Step 4b implemented"): the
// SQL a buyer-facing read folds into a statement it already runs, and the
// helpers that resolve what it returns with the one fallback chain
// (`translationChain`, @scalius/shared/translations).
//
// - A root read (no presence) folds no translation: it is today's read. Only
//   the resource's localized handles (its hreflang alternates) ride in a
//   single-resource read at every presence, the root included.
// - A presence read folds, per resource row, the translations of the
//   presence's locale and of the store default locale (the root presence's)
//   for every market or the presence's own, and the presence-locale handle.
//   The presence is a validated `<locale>-<country>` literal, so the fold
//   binds no parameter and adds no statement. A resource without
//   translations folds NULL, and its record is returned as it was read.
// - Dependencies: `tr:<type>:<id>` for every resource the read resolves (a
//   product's SKUs, options and values advance `tr:product:<id>`) and
//   `tr:locales` (which locale and market the presence is, the default
//   locale). The JSON is built with `json_object` over text and
//   `group_concat`, which both providers run.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID } from "@scalius/database/schema";
import {
  parseTranslationFields,
  presenceLocale,
  resolveTranslatedRecord,
  translationChain,
  type TranslatableResourceType,
  type TranslationContext,
  type TranslationRow,
} from "@scalius/shared/translations";
import { isLanguageSubfolder, isMarketSubfolder } from "@scalius/shared/markets";
import { deps } from "../../cache-deps";

/** A presence read's translation scope: the subfolder and its locale. */
export interface TranslationScope {
  presence: string;
  locale: string;
}

/** The scope of a presence (`bn-bd`); null at the root or for a malformed value. */
export function translationScope(presence: string | null | undefined): TranslationScope | null {
  if (!isMarketSubfolder(presence)) return null;
  return { presence, locale: presenceLocale(presence)! };
}

/** The scope a read's pricing names (catalogue reads pass their market pricing). */
export function translationScopeOf(pricing: { presence: string } | null | undefined): TranslationScope | null {
  return translationScope(pricing?.presence);
}

const typeLiteral = (type: TranslatableResourceType) => sql.raw(`'${type}'`);
const presenceLiteral = (scope: TranslationScope) => sql.raw(`'${scope.presence}'`);
const localeLiteral = (scope: TranslationScope) => sql.raw(`'${scope.locale}'`);

/**
 * The rows of a translation a presence resolves: its locale and the default
 * locale, every market or its own. A language subfolder of the backup market
 * (`bn`) is not stored: its locale while the language is published, and the
 * backup market.
 */
function presenceRowsCondition(scope: TranslationScope, alias: string): SQL {
  const row = sql.raw(alias);
  if (isLanguageSubfolder(scope.presence)) {
    return sql`${row}.locale IN (
        (SELECT tr_language.locale FROM store_languages AS tr_language WHERE tr_language.locale = ${localeLiteral(scope)} AND tr_language.published = 1),
        (SELECT tr_presence.locale FROM market_presences AS tr_presence WHERE tr_presence.kind = 'subfolder' AND tr_presence.value = ''))
      AND (${row}.market_id IS NULL OR ${row}.market_id = ${sql.raw(`'${BACKUP_MARKET_ID}'`)})`;
  }
  return sql`${row}.locale IN (SELECT tr_presence.locale FROM market_presences AS tr_presence WHERE tr_presence.kind = 'subfolder' AND tr_presence.value IN (${presenceLiteral(scope)}, ''))
    AND (${row}.market_id IS NULL OR ${row}.market_id = (SELECT tr_market.market_id FROM market_presences AS tr_market WHERE tr_market.kind = 'subfolder' AND tr_market.value = ${presenceLiteral(scope)}))`;
}

/**
 * The translations of one resource row a presence resolves, as JSON text
 * (`[{"l":locale,"m":market,"f":"<fields JSON>"}]`), or NULL without any.
 * Declares `tr:locales`; the reader declares the resource ids it resolves
 * (`declareTranslated`).
 */
export function translationRowsSql(scope: TranslationScope, type: TranslatableResourceType, id: SQLWrapper): SQL<string | null> {
  deps.translationLocales();
  return sql<string | null>`(SELECT '[' || group_concat(json_object('l', tr_row.locale, 'm', tr_row.market_id, 'f', tr_row.fields), ',') || ']'
    FROM translations AS tr_row
    WHERE tr_row.resource_type = ${typeLiteral(type)} AND tr_row.resource_id = ${id} AND ${presenceRowsCondition(scope, "tr_row")})`;
}

/**
 * Every translation of a product and its SKUs, options and option values a
 * presence resolves, in one JSON text (`t` type, `i` id), for the product
 * page's first statement.
 */
export function productTranslationRowsSql(scope: TranslationScope, productId: SQLWrapper): SQL<string | null> {
  deps.translationLocales();
  return sql<string | null>`(SELECT '[' || group_concat(json_object('t', tr_row.resource_type, 'i', tr_row.resource_id, 'l', tr_row.locale, 'm', tr_row.market_id, 'f', tr_row.fields), ',') || ']'
    FROM (
      SELECT * FROM translations AS tr_own WHERE tr_own.resource_type = 'product' AND tr_own.resource_id = ${productId}
      UNION ALL SELECT tr_sku.* FROM translations AS tr_sku
        WHERE tr_sku.resource_type = 'product_variant' AND tr_sku.resource_id IN (SELECT tr_sku_row.id FROM product_variants AS tr_sku_row WHERE tr_sku_row.product_id = ${productId})
      UNION ALL SELECT tr_option.* FROM translations AS tr_option
        WHERE tr_option.resource_type = 'product_option' AND tr_option.resource_id IN (SELECT tr_option_row.id FROM product_option_definitions AS tr_option_row WHERE tr_option_row.product_id = ${productId})
      UNION ALL SELECT tr_value.* FROM translations AS tr_value
        WHERE tr_value.resource_type = 'product_option_value' AND tr_value.resource_id IN (
          SELECT tr_value_row.id FROM product_option_values AS tr_value_row
          JOIN product_option_definitions AS tr_value_option ON tr_value_option.id = tr_value_row.option_definition_id
          WHERE tr_value_option.product_id = ${productId})
    ) AS tr_row
    WHERE ${presenceRowsCondition(scope, "tr_row")})`;
}

/** The presence-locale handle of one resource row, or NULL. */
export function localizedSlugSql(scope: TranslationScope, type: TranslatableResourceType, id: SQLWrapper): SQL<string | null> {
  return sql<string | null>`(SELECT tr_slug.slug FROM localized_slugs AS tr_slug
    WHERE tr_slug.resource_type = ${typeLiteral(type)} AND tr_slug.resource_id = ${id} AND tr_slug.locale = ${localeLiteral(scope)})`;
}

/**
 * Every localized handle of one resource row (`<locale>:<handle>,...`), or
 * NULL: the hreflang alternates of its page, at every presence and the root.
 * Handles are ASCII words and dashes and locales two letters, so the list is
 * unambiguous. The reader declares the resource's `tr:` key.
 */
export function localizedSlugsSql(type: TranslatableResourceType, id: SQLWrapper): SQL<string | null> {
  return sql<string | null>`(SELECT group_concat(tr_alt.locale || ':' || tr_alt.slug, ',') FROM localized_slugs AS tr_alt
    WHERE tr_alt.resource_type = ${typeLiteral(type)} AND tr_alt.resource_id = ${id})`;
}

/** Above this many resources a read declares the tables' coarse keys instead of one key each. */
const TRANSLATED_KEYS_MAX = 128;

/** Declares the `tr:` key of each resource a read resolved (the coarse table keys for a long list). */
export function declareTranslated(type: TranslatableResourceType, ids: Iterable<string | null | undefined>): void {
  if (!deps.active()) return;
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length > TRANSLATED_KEYS_MAX) {
    deps.table("translations");
    deps.table("localized_slugs");
    return;
  }
  deps.translations(type, unique);
}

// ---------------------------------------------------------------------------
// Resolving folded rows
// ---------------------------------------------------------------------------

interface FoldedRow {
  t?: unknown;
  i?: unknown;
  l?: unknown;
  m?: unknown;
  f?: unknown;
}

function parseFolded(value: unknown): FoldedRow[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as FoldedRow[] : [];
  } catch {
    return [];
  }
}

function toRow(row: FoldedRow): TranslationRow | null {
  if (typeof row.l !== "string") return null;
  return {
    locale: row.l,
    marketId: typeof row.m === "string" && row.m !== "" ? row.m : null,
    fields: parseTranslationFields(row.f),
  };
}

/**
 * The fallback chain of one resource from its folded rows. The fold already
 * kept only the presence's locale and the default locale, every market or
 * the presence's own, so any market-specific row is the presence market's,
 * and the default locale is the one that is not the presence's.
 */
export function foldedTranslationChain(scope: TranslationScope, folded: unknown): TranslationRow[] {
  const rows = parseFolded(folded).map(toRow).filter((row): row is TranslationRow => row !== null);
  return chainOf(scope, rows);
}

function chainOf(scope: TranslationScope, rows: readonly TranslationRow[]): TranslationRow[] {
  if (rows.length === 0) return [];
  const marketId = rows.find((row) => row.marketId !== null)?.marketId ?? null;
  const defaultLocale = rows.find((row) => row.locale !== scope.locale)?.locale ?? scope.locale;
  return translationChain(rows, { locale: scope.locale, marketId, defaultLocale });
}

/** The chains of every resource in a product fold, by `<type>:<id>`. */
export function foldedProductChains(scope: TranslationScope, folded: unknown): Map<string, TranslationRow[]> {
  const byResource = new Map<string, TranslationRow[]>();
  for (const entry of parseFolded(folded)) {
    const row = toRow(entry);
    if (!row || typeof entry.t !== "string" || typeof entry.i !== "string") continue;
    const key = `${entry.t}:${entry.i}`;
    const list = byResource.get(key) ?? [];
    list.push(row);
    byResource.set(key, list);
  }
  return new Map([...byResource].map(([key, rows]) => [key, chainOf(scope, rows)]));
}

/**
 * A record with its translated fields (`fields`: record key → translation
 * field) and, when the fold carried one, its localized handle in `slug`.
 * Untranslated, the same record is returned.
 */
export function applyTranslation<T extends object>(
  record: T,
  chain: readonly TranslationRow[],
  fields: Readonly<Record<string, string>>,
  localizedSlug?: string | null,
): T {
  let next = record;
  if (chain.length > 0) {
    // Map record keys to translation fields when they differ (`title` ← `name`).
    const renamed: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const [recordKey, field] of Object.entries(fields)) {
      renamed[field] = (record as Record<string, unknown>)[recordKey];
      keys.push(field);
    }
    const resolved = resolveTranslatedRecord(renamed, chain, keys);
    if (resolved !== renamed) {
      const copy = { ...record } as Record<string, unknown>;
      for (const [recordKey, field] of Object.entries(fields)) copy[recordKey] = resolved[field];
      next = copy as T;
    }
  }
  if (localizedSlug && "slug" in record && (record as { slug?: unknown }).slug !== localizedSlug) {
    next = { ...next, slug: localizedSlug };
  }
  return next;
}

/**
 * A presence's translation context as one JSON text (`{"l","m","d"}`), for a
 * resource that carries its own translations (the theme document's
 * `translations`) and is read in a statement the page already runs: the
 * presence's locale while it is served (a language subfolder only while its
 * language is published), its market, and the store default locale. Literal
 * presence only, so it binds no parameter. Declares `tr:locales`.
 */
export function translationContextSql(scope: TranslationScope): SQL<string | null> {
  deps.translationLocales();
  const language = isLanguageSubfolder(scope.presence);
  const locale = language
    ? sql`(SELECT tr_language.locale FROM store_languages AS tr_language WHERE tr_language.locale = ${localeLiteral(scope)} AND tr_language.published = 1)`
    : sql`(SELECT tr_presence.locale FROM market_presences AS tr_presence WHERE tr_presence.kind = 'subfolder' AND tr_presence.value = ${presenceLiteral(scope)})`;
  const market = language
    ? sql.raw(`'${BACKUP_MARKET_ID}'`)
    : sql`(SELECT tr_market.market_id FROM market_presences AS tr_market WHERE tr_market.kind = 'subfolder' AND tr_market.value = ${presenceLiteral(scope)})`;
  return sql<string | null>`json_object('l', ${locale}, 'm', ${market}, 'd',
    (SELECT tr_default.locale FROM market_presences AS tr_default WHERE tr_default.kind = 'subfolder' AND tr_default.value = ''))`;
}

/** A `translationContextSql` value as the chain's context; null when the presence is not served in a language. */
export function parseTranslationContext(value: unknown): TranslationContext | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { l, m, d } = parsed as { l?: unknown; m?: unknown; d?: unknown };
  if (typeof l !== "string" || l === "") return null;
  return { locale: l, marketId: typeof m === "string" && m !== "" ? m : null, defaultLocale: typeof d === "string" && d !== "" ? d : l };
}

/** Parses a `localizedSlugsSql` value into locale → handle. */
export function parseLocalizedSlugs(value: unknown): Record<string, string> {
  if (typeof value !== "string" || value === "") return {};
  const slugs: Record<string, string> = {};
  for (const item of value.split(",")) {
    const separator = item.indexOf(":");
    if (separator === 2) slugs[item.slice(0, 2)] = item.slice(3);
  }
  return slugs;
}

/**
 * The chains of a few resources read on their own (delivery rates, payment
 * methods: rows that come from code or a read this domain cannot fold into),
 * in one statement at a presence and none at the root. Declares each
 * resource's key and `tr:locales`.
 */
export async function readTranslationChains(
  db: Database,
  scope: TranslationScope | null,
  type: TranslatableResourceType,
  ids: readonly string[],
): Promise<Map<string, TranslationRow[]>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!scope || unique.length === 0) return new Map();
  deps.translationLocales();
  declareTranslated(type, unique);
  const rows = await db.all(sql`SELECT tr_row.resource_id AS "id", json_object('l', tr_row.locale, 'm', tr_row.market_id, 'f', tr_row.fields) AS "row"
    FROM translations AS tr_row
    WHERE tr_row.resource_type = ${typeLiteral(type)}
      AND tr_row.resource_id IN (SELECT value FROM json_each(${JSON.stringify(unique)}))
      AND ${presenceRowsCondition(scope, "tr_row")}`) as unknown[];
  const byId = new Map<string, TranslationRow[]>();
  for (const raw of rows) {
    const [id, value] = Array.isArray(raw) ? raw : [(raw as { id: unknown }).id, (raw as { row: unknown }).row];
    const row = toRow(typeof value === "string" ? JSON.parse(value) as FoldedRow : value as FoldedRow);
    if (typeof id !== "string" || !row) continue;
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  return new Map([...byId].map(([id, list]) => [id, chainOf(scope, list)]));
}
