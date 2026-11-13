// The search-text backfill. A rich-text column's search text (its companion
// column, `richTextSearchText`) is written with the text by the write path; a
// row written before migration 0219, or by SQL that bypassed the write path
// (or cleared by a `*_stale` trigger), has none, and search indexes the first
// SEARCH_TEXT_MAX_LENGTH characters of its raw column meanwhile. A scheduled
// slice fills such rows, in id order through each table's partial "pending"
// index; the filled rows are the progress (a killed slice leaves the rest
// pending), and each filled row re-indexes through the normal search triggers.
//
// Bounded by construction: a row is read only to its first
// SEARCH_HTML_MAX_LENGTH characters (what its search text depends on, so a
// 10 MB row costs what a 40 KB one does), and a slice stops at its rows and
// characters. A row whose raw text indexes exactly as its search text would
// is marked as needing none (its revision -1: no index or cache write); a row
// whose search text cannot be computed is marked as failed (-2) and logged,
// never retried ahead of the rest. Either mark lasts until the row's text
// changes.
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { categories, pages, products } from "@scalius/database/schema";
import { codePointPrefix, rawTextIsItsSearchText, richTextSearchText, SEARCH_HTML_MAX_LENGTH } from "@scalius/shared/search-text";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

interface BackfilledColumn {
  table: SQLiteTable;
  name: string;
  id: SQLiteColumn;
  raw: SQLiteColumn;
  companion: SQLiteColumn;
  revision: SQLiteColumn;
  /** The companion's and the revision's properties in the table's update shape. */
  keys: { text: "descriptionSearchText" | "contentSearchText"; revision: "descriptionSearchRev" | "contentSearchRev" };
}

const DESCRIPTION = { text: "descriptionSearchText", revision: "descriptionSearchRev" } as const;

/** The rich-text columns and their companions, matching each table's pending index (migration 0219). */
const COLUMNS: readonly BackfilledColumn[] = [
  { table: products, name: "products", id: products.id, raw: products.description, companion: products.descriptionSearchText, revision: products.descriptionSearchRev, keys: DESCRIPTION },
  { table: categories, name: "categories", id: categories.id, raw: categories.description, companion: categories.descriptionSearchText, revision: categories.descriptionSearchRev, keys: DESCRIPTION },
  { table: pages, name: "pages", id: pages.id, raw: pages.content, companion: pages.contentSearchText, revision: pages.contentSearchRev, keys: { text: "contentSearchText", revision: "contentSearchRev" } },
];

/** The characters of a row a slice reads: the search text's prefix and one more (`richTextSearchText` depends on nothing else). */
const READ = SEARCH_HTML_MAX_LENGTH + 1;

/** The revision of a row that indexes its raw text as its search text, and of one whose search text failed. */
export const SEARCH_TEXT_RAW_IS_TEXT = -1;
export const SEARCH_TEXT_FAILED = -2;

/**
 * The rows the pending index holds: a raw value, no search text, and no mark.
 * The 0 is literal SQL: a bound parameter would not prove the partial index's
 * condition, and every probe would scan the table.
 */
const pending = (column: BackfilledColumn): SQL => and(isNull(column.companion), isNotNull(column.raw), sql`${column.revision} >= 0`)!;

/** One indexed probe per table: is any row still waiting? */
export function searchTextBackfillDueProbes(db: Database) {
  return COLUMNS.map((column) => db.select({ id: column.id }).from(column.table).where(pending(column)).limit(1));
}

export interface SearchTextBackfillResult {
  /** Rows given their search text. */
  filled: number;
  /** Rows marked as indexing as they are. */
  unchanged: number;
  /** Rows whose search text failed, marked and logged. */
  failed: number;
  /** Whether rows may remain (the slice stopped at a bound). */
  more: boolean;
}

/**
 * One slice: at most `rows` waiting rows (tables in order, each in id order)
 * and `characters` characters of rich text read (always at least one row),
 * written in one batch. A row whose text changed since it was read is left
 * alone (its guard: still waiting, and the same first characters, all its
 * search text depends on).
 */
export async function backfillSearchText(
  db: Database,
  limits: { rows: number; characters: number },
  compute: (html: string) => string | null = richTextSearchText,
): Promise<SearchTextBackfillResult> {
  const updates = [];
  const result: SearchTextBackfillResult = { filled: 0, unchanged: 0, failed: 0, more: false };
  let rows = limits.rows;
  let characters = limits.characters;
  for (const column of COLUMNS) {
    if (rows <= 0 || characters <= 0) {
      result.more = true;
      break;
    }
    // One character past the bound: what the search text depends on (its prefix, and whether there is more).
    const prefix = sql<string>`substr(${column.raw}, 1, ${READ})`;
    const read = await db.select({ id: column.id, prefix }).from(column.table)
      .where(pending(column)).orderBy(asc(column.id)).limit(rows + 1).all() as Array<{ id: string; prefix: string }>;
    for (const row of read) {
      if (rows <= 0 || (characters <= 0 && updates.length > 0)) {
        result.more = true;
        break;
      }
      const html = codePointPrefix(row.prefix, READ);
      rows -= 1;
      characters -= Math.min(html.length, SEARCH_HTML_MAX_LENGTH);
      const guard = and(eq(column.id, row.id), pending(column), sql`substr(${column.raw}, 1, ${READ}) = ${html}`);
      let values: Record<string, unknown>;
      if (rawTextIsItsSearchText(html)) {
        values = { [column.keys.revision]: SEARCH_TEXT_RAW_IS_TEXT };
        result.unchanged += 1;
      } else {
        try {
          values = { [column.keys.text]: compute(html) ?? "" };
          result.filled += 1;
        } catch (error) {
          console.warn(`[scheduled] search_text_backfill: ${column.name} ${row.id} failed; marked and skipped:`, error instanceof Error ? error.name : "error");
          values = { [column.keys.revision]: SEARCH_TEXT_FAILED };
          result.failed += 1;
        }
      }
      updates.push(db.update(column.table).set(values).where(guard));
    }
  }
  if (updates.length > 0) await safeBatch(db, updates as unknown as Parameters<typeof safeBatch>[1]);
  return result;
}
