// Which way a dashboard list reads a large table (SQLite: D1, Turso).
//
// A filter that names a set of rows (a search's matches, the orders with an
// open request, the customers with a tag) can be read two ways: walk the
// sort index and test each row against the set, or read the set first and
// sort it. SQLite has no table statistics, so it cannot tell which is
// cheaper: a rare search walks a million index rows to find none, a common
// one sorts tens of thousands of matches. One capped count of each set
// decides: a list reads a set first when it holds at most LIST_LEAD_LIMIT
// rows, and the query then writes its base condition with a unary `+` so
// SQLite stays off the sort indexes.
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

/** A named set of at most this many rows is read first. */
export const LIST_LEAD_LIMIT = 2_000;

/** Whether any of these sets (each a SELECT) holds at most `LIST_LEAD_LIMIT` rows. One statement. */
export async function anySetIsSmall(db: Database, sets: readonly SQL[]): Promise<boolean> {
    if (sets.length === 0) return false;
    const counts = sets.map((set) => sql`SELECT count(*) AS size FROM (SELECT 1 FROM (${set}) AS lead_set LIMIT ${LIST_LEAD_LIMIT + 1}) AS capped`);
    const [row] = await db.all<unknown>(sql`SELECT min(size) AS smallest FROM (${sql.join(counts, sql` UNION ALL `)}) AS sizes`);
    // D1 returns a row as an array of values, the other providers as an object.
    const smallest = Array.isArray(row) ? row[0] : (row as { smallest?: unknown } | undefined)?.smallest;
    return Number(smallest ?? Number.POSITIVE_INFINITY) <= LIST_LEAD_LIMIT;
}
