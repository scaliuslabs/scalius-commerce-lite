// The scheduled fill of D1's FTS5 tables after 0219. 0219 makes each table's
// newest rows current itself (FTS5_MIGRATION_ROWS); a table with more rows
// keeps an old-through rowid (`settings`, `fts5OldThroughKey`): every row
// above it is indexed in the current form, every row at or below it in the
// raw form every trigger before 0219 wrote, and stays findable. The
// triggers read that boundary, so each write keeps its row in its zone's
// form. A slice moves the boundary down over the next newest rows, in one
// batch: the rows whose current form differs from their raw form have their
// raw-form entries deleted (exactly what the old triggers wrote) and their
// current-form entries written. The batch only applies while the boundary is
// still the one it read, so two overlapping ticks never rewrite a row twice.
// D1 only; Turso and PostgreSQL search their own index.
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import {
  FTS5_FILL_ROW_COST,
  FTS5_OLD_THROUGH_KEYS,
  SEARCH_SOURCES,
  fts5ColumnNames,
  fts5FormsDifferSql,
  fts5NewFormValuesSql,
  fts5OldFormValuesSql,
  fts5OldThroughKey,
  type SearchSource,
} from "@scalius/database/search-index";
import { sql } from "drizzle-orm";

import { isFts5SearchEnabled } from "./text-search";

const SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];
/** Fill order: what buyers search first (the catalogue, then pages), then the dashboard's searches. */
const FILL_ORDER: readonly SearchSource[] = [
  "products", "categories", "pages", "orders", "customers", "product_reviews", "product_variants", "navigation_menu_items", "abandoned_checkouts",
];

const id = (name: string) => sql.raw(`"${name}"`);

/** Whether a fill is pending: on D1, while any old-through row exists (an index seek that reads no row once none does). */
export function fts5ReindexDueProbes(db: Database) {
  if (!isFts5SearchEnabled(db)) return [];
  return [sql`SELECT 1 FROM settings WHERE key >= ${FTS5_OLD_THROUGH_KEYS.from} AND key < ${FTS5_OLD_THROUGH_KEYS.to} AND category = 'maintenance'`];
}

/** Each table still being filled and its old-through rowid. */
export async function readFts5OldThrough(db: Database): Promise<Map<SearchSource, number>> {
  if (!isFts5SearchEnabled(db)) return new Map();
  const rows = await db.all<{ key: string; value: string } | [string, string]>(
    sql`SELECT key, value FROM settings WHERE key >= ${FTS5_OLD_THROUGH_KEYS.from} AND key < ${FTS5_OLD_THROUGH_KEYS.to} AND category = 'maintenance'`,
  );
  const result = new Map<SearchSource, number>();
  for (const row of rows) {
    const [key, value] = Array.isArray(row) ? row : [row.key, row.value];
    const source = key.slice(FTS5_OLD_THROUGH_KEYS.from.length) as SearchSource;
    if (SOURCES.includes(source)) result.set(source, Number(value));
  }
  return result;
}

export interface Fts5ReindexResult {
  /** Source rows the slice passed. */
  read: number;
  /** Rows written, about (FTS5_FILL_ROW_COST per row whose form changed). */
  written: number;
  /** Every table is current. */
  finished: boolean;
  /** Each table still being filled: its old-through rowid after the slice, or "done". */
  progress: Record<string, string>;
}

/**
 * One slice, tables in fill order: the newest rows at or below each table's
 * boundary, at most `reads` rows read and `writes` rows written (a row whose
 * form does not change costs a read only).
 */
export async function reindexFts5Slice(db: Database, limits: { writes: number; reads: number }): Promise<Fts5ReindexResult> {
  const boundaries = await readFts5OldThrough(db);
  let writes = limits.writes;
  let reads = limits.reads;
  let read = 0;
  let written = 0;
  const progress: Record<string, string> = {};
  for (const source of FILL_ORDER) {
    const oldThrough = boundaries.get(source);
    if (oldThrough === undefined) continue;
    if (reads <= 0 || writes < FTS5_FILL_ROW_COST) {
      progress[source] = String(oldThrough);
      continue;
    }
    // The next newest rows, each with whether its form changes.
    const window = (await db.all<{ rowid: number; changes: number } | [number, number]>(
      sql`SELECT src.rowid AS rowid, ${sql.raw(fts5FormsDifferSql(source, "src"))} AS changes FROM ${id(source)} AS src WHERE src.rowid <= ${oldThrough} ORDER BY src.rowid DESC LIMIT ${reads}`,
    )).map((row) => Array.isArray(row) ? { rowid: Number(row[0]), changes: Boolean(row[1]) } : { rowid: Number(row.rowid), changes: Boolean(row.changes) });
    // As far as the write budget reaches.
    let taken = 0;
    let changed = 0;
    for (const row of window) {
      if (row.changes && (changed + 1) * FTS5_FILL_ROW_COST > writes) break;
      if (row.changes) changed += 1;
      taken += 1;
    }
    const done = taken === window.length && window.length < reads;
    const low = taken > 0 ? window[taken - 1]!.rowid : oldThrough + 1;
    if (taken > 0 || done) await safeBatch(db, fillStatements(db, source, low, oldThrough, done) as unknown as Parameters<typeof safeBatch>[1]);
    read += taken;
    reads -= taken;
    written += changed * FTS5_FILL_ROW_COST;
    writes -= changed * FTS5_FILL_ROW_COST;
    progress[source] = done ? "done" : String(low - 1);
    if (!done) break;
  }
  const finished = [...boundaries.keys()].every((source) => progress[source] === "done");
  return { read, written, finished, progress };
}

/**
 * The batch that makes rows `low`..`oldThrough` of `source` current and moves
 * its boundary below them. Plain SQL text (D1 batches bound raw statements
 * poorly): every value is an integer rowid or a fixed key.
 */
function fillStatements(db: Database, source: SearchSource, low: number, oldThrough: number, done: boolean) {
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(oldThrough)) throw new Error(`fts5 fill: bad rowid window for ${source}`);
  const table = `"${source}_fts"`;
  const key = `'${fts5OldThroughKey(source)}'`;
  const columns = fts5ColumnNames(source).map((column) => `"${column}"`).join(", ");
  // Applied only while the boundary is still the one this slice read.
  const unmoved = `EXISTS (SELECT 1 FROM settings WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}')`;
  // Only a row whose current form differs from its raw form is written again.
  const changed = `src.rowid >= ${low} AND src.rowid <= ${oldThrough} AND ${unmoved} AND ${fts5FormsDifferSql(source, "src")}`;
  const text = [
    `INSERT INTO ${table} (${table}, rowid, ${columns}) SELECT 'delete', src.rowid, ${fts5OldFormValuesSql(source, "src").join(", ")} FROM "${source}" AS src WHERE ${changed}`,
    `INSERT INTO ${table} (rowid, ${columns}) SELECT src.rowid, ${fts5NewFormValuesSql(source, "src").join(", ")} FROM "${source}" AS src WHERE ${changed}`,
    done
      ? `DELETE FROM settings WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}'`
      : `UPDATE settings SET value = '${low - 1}' WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}'`,
  ];
  return text.map((statement) => db.run(sql.raw(statement)));
}
