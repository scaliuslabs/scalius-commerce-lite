// "Is anything due": one statement before the every-minute drains.
//
// Each drain owns its probes: bounded index lookups of one row with exactly
// the condition its own list query uses, one per due state (a pending retry,
// a lapsed lease), so a probe finds a row whenever its drain would. The cron
// asks them all in one SELECT (a column a drain) and runs, and imports, only
// the drains that have work; an idle store's tick pays one D1 query for all
// of them. If the probe statement fails, every drain runs, as before.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

export interface DueProbedDrain {
  name: string;
  /** The drain's probes; absent for a drain that costs no query when idle. */
  due?: (db: Database) => readonly SQLWrapper[] | Promise<readonly SQLWrapper[]>;
}

/**
 * The names of the probed drains that have due work, or null when the probe
 * could not be read (run everything). One statement, whatever the count.
 */
export async function readDueDrains(db: Database, drains: readonly DueProbedDrain[]): Promise<Set<string> | null> {
  try {
    const names: string[] = [];
    const columns: SQL[] = [];
    for (const drain of drains) {
      if (!drain.due) continue;
      const probes = await drain.due(db);
      if (probes.length === 0) continue;
      // getSQL(): the statement itself, not the parenthesized subquery a builder renders as.
      const exists = sql.join(probes.map((probe) => sql`EXISTS (${probe.getSQL()})`), sql` OR `);
      columns.push(sql`CASE WHEN ${exists} THEN 1 ELSE 0 END AS ${sql.raw(`"d${names.length}"`)}`);
      names.push(drain.name);
    }
    if (columns.length === 0) return new Set();
    const [row] = await db.all<unknown>(sql`SELECT ${sql.join(columns, sql`, `)}`);
    // D1 returns a row as an array of values, the other providers as an object.
    const flag = (index: number) => Number(Array.isArray(row) ? row[index] : (row as Record<string, unknown> | undefined)?.[`d${index}`]) === 1;
    return new Set(names.filter((_name, index) => flag(index)));
  } catch (error) {
    console.warn("[scheduled] Due-work probe failed; running every drain:", error instanceof Error ? error.name : "error");
    return null;
  }
}
