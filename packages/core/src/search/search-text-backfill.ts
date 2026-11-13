// The search-text backfill. A rich-text column's search text (its companion
// column, `richTextSearchText`) is written with the text by the write path; a
// row written before migration 0219, or by SQL that bypassed the write path
// (or cleared by a `*_stale` trigger), has none, and search indexes its raw
// column meanwhile. Each scheduled tick fills a bounded slice of such rows,
// in id order through each table's partial "pending" index; the filled rows
// are the progress (a killed tick leaves the rest pending), and each filled
// row re-indexes through the normal search triggers.
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { categories, pages, products } from "@scalius/database/schema";
import { richTextSearchText } from "@scalius/shared/search-text";
import { and, asc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

interface BackfilledColumn {
  table: SQLiteTable;
  id: SQLiteColumn;
  raw: SQLiteColumn;
  companion: SQLiteColumn;
  /** The companion's property in the table's insert and update shape. */
  key: "descriptionSearchText" | "contentSearchText";
}

/** The rich-text columns and their companions, matching each table's pending index (migration 0219). */
const COLUMNS: readonly BackfilledColumn[] = [
  { table: products, id: products.id, raw: products.description, companion: products.descriptionSearchText, key: "descriptionSearchText" },
  { table: categories, id: categories.id, raw: categories.description, companion: categories.descriptionSearchText, key: "descriptionSearchText" },
  { table: pages, id: pages.id, raw: pages.content, companion: pages.contentSearchText, key: "contentSearchText" },
];

/** The rows the pending index holds: a raw value and no search text. */
const pending = (column: BackfilledColumn): SQL => and(isNull(column.companion), isNotNull(column.raw))!;

/** One indexed probe per table: is any row still waiting? */
export function searchTextBackfillDueProbes(db: Database) {
  return COLUMNS.map((column) => db.select({ id: column.id }).from(column.table).where(pending(column)).limit(1));
}

/**
 * Fills the search text of at most `limit` waiting rows (tables in order,
 * each in id order) in one batch. A row whose raw value changed since it was
 * read is skipped: the write that changed it wrote its search text, or the
 * next slice reads it again. Returns the rows written (or skipped) and
 * whether any remain.
 */
export async function backfillSearchText(db: Database, limit: number): Promise<{ filled: number; more: boolean }> {
  const updates = [];
  let remaining = limit;
  let more = false;
  for (const column of COLUMNS) {
    if (remaining <= 0) {
      more = true;
      break;
    }
    const rows = await db.select({ id: column.id, raw: column.raw }).from(column.table)
      .where(pending(column)).orderBy(asc(column.id)).limit(remaining + 1).all() as Array<{ id: string; raw: string | null }>;
    if (rows.length > remaining) more = true;
    for (const row of rows.slice(0, remaining)) {
      updates.push(db.update(column.table)
        .set({ [column.key]: richTextSearchText(row.raw) ?? "" })
        .where(and(eq(column.id, row.id), isNull(column.companion), eq(column.raw, row.raw ?? ""))));
    }
    remaining -= Math.min(rows.length, remaining);
  }
  if (updates.length === 0) return { filled: 0, more: false };
  await safeBatch(db, updates as unknown as Parameters<typeof safeBatch>[1]);
  return { filled: updates.length, more };
}
