// The scheduled fill of D1's FTS5 tables after 0219. 0219 makes each table's
// newest rows current itself (FTS5_MIGRATION_ROWS); a table with more rows
// keeps an old-through rowid (`settings`, `fts5OldThroughKey`): every row
// above it is indexed in the current form, every row at or below it in the
// raw form (a kept table) or not at all (pages_fts and orders_fts, which
// 0219 made again). The triggers read that boundary, so each write keeps its
// row in its zone's form. A slice moves the boundary down over the next
// newest rows, in one batch: a kept table's rows whose form changes have
// their raw-form entries deleted (exactly what the old triggers wrote) and
// their current-form entries written; a recreated table's rows are indexed.
// The batch only applies while the boundary is still the one it read, so two
// overlapping ticks never rewrite a row twice. Recreated tables go first:
// their search misses older rows until they are filled (the dashboard says
// so); a kept table's older rows stay findable in the raw form meanwhile.
// D1 only; Turso and PostgreSQL search their own index.
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import {
  FTS5_OLD_THROUGH_KEYS,
  FTS5_RECREATED_SOURCES,
  SEARCH_SOURCES,
  fts5FillRowCost,
  fts5FormsDifferSql,
  fts5NewFormValuesSql,
  fts5OldFormValuesSql,
  fts5OldThroughKey,
  isFts5RecreatedSource,
  type SearchSource,
} from "@scalius/database/search-index";
import { sql } from "drizzle-orm";

import { isFts5SearchEnabled } from "./text-search";

const SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];
/** Fill order: the tables whose search misses rows first, then the kept ones. */
const FILL_ORDER: readonly SearchSource[] = [...FTS5_RECREATED_SOURCES, ...SOURCES.filter((source) => !isFts5RecreatedSource(source))];

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

/**
 * How far each recreated table's fill has come, for the dashboard's search
 * notice: the share of its rows above the boundary (by rowid), 0 to 1.
 * Absent when the table is complete.
 */
export async function fts5FillProgress(db: Database): Promise<Partial<Record<SearchSource, number>>> {
  const boundaries = await readFts5OldThrough(db);
  const progress: Partial<Record<SearchSource, number>> = {};
  for (const source of FTS5_RECREATED_SOURCES) {
    const oldThrough = boundaries.get(source);
    if (oldThrough === undefined) continue;
    const [row] = await db.all<{ low: number; high: number } | [number, number]>(sql`SELECT min(rowid) AS low, max(rowid) AS high FROM ${id(source)}`);
    const [low, high] = Array.isArray(row) ? row : [row?.low ?? 0, row?.high ?? 0];
    const span = Number(high) - Number(low) + 1;
    progress[source] = span > 0 ? Math.min(1, Math.max(0, (Number(high) - oldThrough) / span)) : 1;
  }
  return progress;
}

export interface Fts5ReindexResult {
  /** Source rows the slice passed (indexed or rewritten, or already current). */
  read: number;
  /** Every table is current. */
  finished: boolean;
  /** Each table still being filled: its old-through rowid after the slice, or "done". */
  progress: Record<string, string>;
}

/**
 * One slice: the newest rows at or below each table's boundary, as many as
 * `writes` allows at FTS5_MIGRATION_ROWS' cost per row, tables in fill order.
 */
export async function reindexFts5Slice(db: Database, limits: { writes: number }): Promise<Fts5ReindexResult> {
  const boundaries = await readFts5OldThrough(db);
  let budget = limits.writes;
  let read = 0;
  const progress: Record<string, string> = {};
  for (const source of FILL_ORDER) {
    const oldThrough = boundaries.get(source);
    if (oldThrough === undefined) continue;
    const rows = Math.floor(budget / fts5FillRowCost(source));
    if (rows <= 0) {
      progress[source] = String(oldThrough);
      continue;
    }
    const window = await db.all<{ rowid: number } | [number]>(
      sql`SELECT rowid FROM ${id(source)} WHERE rowid <= ${oldThrough} ORDER BY rowid DESC LIMIT ${rows}`,
    );
    const rowids = window.map((row) => Number(Array.isArray(row) ? row[0] : row.rowid));
    const done = rowids.length < rows;
    const low = rowids.length > 0 ? rowids[rowids.length - 1]! : 1;
    await safeBatch(db, fillStatements(db, source, low, oldThrough, done) as unknown as Parameters<typeof safeBatch>[1]);
    read += rowids.length;
    budget -= rowids.length * fts5FillRowCost(source);
    progress[source] = done ? "done" : String(low - 1);
    if (!done) break;
  }
  const finished = [...boundaries.keys()].every((source) => progress[source] === "done");
  return { read, finished, progress };
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
  const columns = SEARCH_SOURCES[source].map(([, column]) => `"${column}"`).join(", ");
  // Applied only while the boundary is still the one this slice read.
  const unmoved = `EXISTS (SELECT 1 FROM settings WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}')`;
  const window = `src.rowid >= ${low} AND src.rowid <= ${oldThrough} AND ${unmoved}`;
  const current = fts5NewFormValuesSql(source, "src").join(", ");
  const text: string[] = [];
  if (isFts5RecreatedSource(source)) {
    text.push(`INSERT INTO ${table} (rowid, ${columns}) SELECT src.rowid, ${current} FROM "${source}" AS src WHERE ${window}`);
  } else {
    // Only a row whose current form differs from its raw form is written again.
    const changed = `${window} AND ${fts5FormsDifferSql(source, "src")}`;
    text.push(
      `INSERT INTO ${table} (${table}, rowid, ${columns}) SELECT 'delete', src.rowid, ${fts5OldFormValuesSql(source, "src").join(", ")} FROM "${source}" AS src WHERE ${changed}`,
      `INSERT INTO ${table} (rowid, ${columns}) SELECT src.rowid, ${current} FROM "${source}" AS src WHERE ${changed}`,
    );
  }
  text.push(done
    ? `DELETE FROM settings WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}'`
    : `UPDATE settings SET value = '${low - 1}' WHERE key = ${key} AND category = 'maintenance' AND value = '${oldThrough}'`);
  return text.map((statement) => db.run(sql.raw(statement)));
}
