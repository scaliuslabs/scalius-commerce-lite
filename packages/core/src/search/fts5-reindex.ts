// The scheduled re-index of D1's content-view FTS5 tables
// (FTS5_CONTENT_VIEW_SOURCES). Migration 0219 makes each again, empty, over a
// view of exactly what its triggers index, so the migration reads and writes
// no row of them; this fills them a bounded slice per tick, pages first (the
// storefront's site search reads them), in rowid order. Every row written
// meanwhile is indexed by its triggers at once, and a row is never indexed
// twice (FTS5 keeps one `_docsize` row per indexed row). Until a table is
// filled, its search finds only the rows indexed so far: never a wrong row.
//
// The position is a `settings` maintenance cursor that exists while there is
// work: 0219 writes it on a store with rows to index, the last slice deletes
// it, so a store with nothing to re-index reads no row for it. Each slice
// skips rows already indexed, so re-reading a window writes nothing. D1 only;
// Turso and PostgreSQL search their own index.
import type { Database } from "@scalius/database/client";
import { FTS5_CONTENT_VIEW_SOURCES, FTS5_REINDEX_CURSOR_KEY, SEARCH_SOURCES, type Fts5ContentViewSource } from "@scalius/database/search-index";
import { sql } from "drizzle-orm";

import { isFts5SearchEnabled } from "./text-search";

export { FTS5_REINDEX_CURSOR_KEY };

const id = (name: string) => sql.raw(`"${name}"`);

/** Whether the re-index has work: on D1, while its cursor exists (an index seek that reads no row once it is gone). */
export function fts5ReindexDueProbes(db: Database) {
  if (!isFts5SearchEnabled(db)) return [];
  return [sql`SELECT 1 FROM settings WHERE category = 'maintenance' AND key = ${FTS5_REINDEX_CURSOR_KEY}`];
}

export interface Fts5ReindexResult {
  /** The cursor to save: each unfinished table's last rowid read, "done" for a filled one. */
  cursor: Record<string, string>;
  /** Every table is filled: delete the cursor. */
  finished: boolean;
  /** Rows given their index entries this slice. */
  indexed: number;
  /** Source rows read this slice (indexed ones included). */
  scanned: number;
  /** Each table's position, for the log: "<last rowid read>/<largest rowid>" or "done". */
  progress: Record<string, string>;
}

/**
 * One slice: at most `rows` source rows read, tables in order, each from
 * just after its cursor; each row not yet indexed is indexed from its content
 * view. A table whose rows are all read is marked done.
 */
export async function reindexFts5Slice(
  db: Database,
  limits: { rows: number },
  cursor: Readonly<Record<string, string>>,
): Promise<Fts5ReindexResult> {
  const next: Record<string, string> = {};
  const progress: Record<string, string> = {};
  let budget = limits.rows;
  let indexed = 0;
  let scanned = 0;
  for (const source of FTS5_CONTENT_VIEW_SOURCES) {
    const from = cursor[source] ?? "0";
    if (from === "done") {
      next[source] = "done";
      progress[source] = "done";
      continue;
    }
    if (budget <= 0) {
      next[source] = from;
      continue;
    }
    const position = Number(from);
    const window = await db.all<{ rowid: number } | [number]>(
      sql`SELECT rowid FROM ${id(source)} WHERE rowid > ${position} ORDER BY rowid LIMIT ${budget}`,
    );
    const rowids = window.map((row) => Number(Array.isArray(row) ? row[0] : row.rowid));
    if (rowids.length === 0) {
      next[source] = "done";
      progress[source] = "done";
      continue;
    }
    const last = rowids[rowids.length - 1]!;
    indexed += await indexWindow(db, source, position, last);
    scanned += rowids.length;
    // Fewer rows than asked: the table is read through (a row written later is indexed by its triggers).
    if (rowids.length < budget) {
      budget -= rowids.length;
      next[source] = "done";
      progress[source] = "done";
      continue;
    }
    budget -= rowids.length;
    next[source] = String(last);
    const [largest] = await db.all<{ n: number } | [number]>(sql`SELECT max(rowid) AS n FROM ${id(source)}`);
    progress[source] = `${last}/${Number(Array.isArray(largest) ? largest[0] : largest?.n)}`;
  }
  const finished = FTS5_CONTENT_VIEW_SOURCES.every((source) => next[source] === "done");
  return { cursor: next, finished, indexed, scanned, progress };
}

/** Index the rows of `source` with rowid in (from, to] that are not indexed yet; the number indexed. */
async function indexWindow(db: Database, source: Fts5ContentViewSource, from: number, to: number): Promise<number> {
  const table = `${source}_fts`;
  const columns = sql.join(SEARCH_SOURCES[source].map(([, column]) => id(column)), sql`, `);
  const pending = sql`FROM ${id(`${source}_fts_content`)} AS view_row WHERE view_row.rowid > ${from} AND view_row.rowid <= ${to}
    AND NOT EXISTS (SELECT 1 FROM ${id(`${table}_docsize`)} AS indexed WHERE indexed.id = view_row.rowid)`;
  const [count] = await db.all<{ n: number } | [number]>(sql`SELECT count(*) AS n ${pending}`);
  const n = Number(Array.isArray(count) ? count[0] : count?.n);
  if (n > 0) await db.run(sql`INSERT INTO ${id(table)} (rowid, ${columns}) SELECT view_row.rowid, ${columns} ${pending}`);
  return n;
}
