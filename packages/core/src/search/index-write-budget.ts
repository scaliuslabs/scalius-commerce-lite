// One daily ceiling over the background work that writes search index rows
// (the search-text backfill and the FTS5 fill), on plans that set one
// (`planLimits().background.indexWritesPerDay`: a quarter of Workers Free's
// 100,000 daily writes). Over D1's daily limit every write is refused until
// UTC midnight, checkout included, so this work never takes more than its
// share. The count is one `settings` row (category `maintenance`, key
// `index-writes`, value `<UTC day>:<rows>`); migration 0219 writes its own
// rows into it on the day it runs. Each job reads what is left before it
// runs and adds what it wrote (an upper estimate) after.
import type { Database } from "@scalius/database/client";
import { FTS5_INDEX_WRITES_KEY } from "@scalius/database/search-index";
import { sql } from "drizzle-orm";

/** Rows written per row the search-text backfill fills (its row, its index entries, the search key), an upper estimate. */
export const SEARCH_TEXT_FILLED_ROW_WRITES = 12;

export interface IndexWriteBudget {
  /** Rows left today (Infinity without a ceiling). */
  readonly remaining: number;
  /** Adds `rows` to today's count. */
  charge(rows: number): Promise<void>;
}

/** The UTC day of `at`, as D1's daily limits count it. */
export function indexWritesDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export async function readIndexWriteBudget(db: Database, at: number, perDay: number | null): Promise<IndexWriteBudget> {
  if (perDay === null) return { remaining: Number.POSITIVE_INFINITY, charge: async () => undefined };
  const day = indexWritesDay(at);
  const rows = await db.all<{ value: string } | [string]>(
    sql`SELECT value FROM settings WHERE key = ${FTS5_INDEX_WRITES_KEY} AND category = 'maintenance'`,
  );
  const value = rows[0] === undefined ? "" : String(Array.isArray(rows[0]) ? rows[0][0] : rows[0].value);
  const used = value.startsWith(`${day}:`) ? Number(value.slice(day.length + 1)) || 0 : 0;
  return {
    remaining: Math.max(0, perDay - used),
    async charge(written: number) {
      const rows = Math.ceil(written);
      if (!(rows > 0)) return;
      await db.run(sql`INSERT INTO settings (id, category, key, type, value)
        VALUES (${`maintenance:${FTS5_INDEX_WRITES_KEY}`}, 'maintenance', ${FTS5_INDEX_WRITES_KEY}, 'string', ${`${day}:${rows}`})
        ON CONFLICT (key, category) DO UPDATE SET value = CASE
          WHEN settings.value LIKE ${`${day}:%`} THEN ${`${day}:`} || (CAST(substr(settings.value, ${day.length + 2}) AS INTEGER) + ${rows})
          ELSE ${`${day}:${rows}`} END`);
    },
  };
}
