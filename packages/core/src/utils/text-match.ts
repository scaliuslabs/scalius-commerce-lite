// Text matching in SQL without LIKE. Cloudflare D1 refuses a LIKE or GLOB
// pattern over 50 bytes ("LIKE or GLOB pattern too complex"), bound values
// included: a search term of 49 bytes (16 Bangla letters) or a derived handle
// longer than that would fail only on D1. These helpers have no length limit,
// take the value literally (`%` and `_` are plain characters) and run the
// same on D1, Turso and PostgreSQL (the PostgreSQL profile defines `instr`).
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** The column contains `term`, ignoring case as SQLite's LIKE does. */
export function containsText(column: SQLWrapper, term: string): SQL {
    return sql`instr(lower(${column}), lower(${term})) > 0`;
}

/** The column starts with `prefix`, case as stored (handles and SKU keys are lower-case). */
export function startsWithText(column: SQLWrapper, prefix: string): SQL {
    // substr counts characters (code points), as `[...prefix]` does.
    return sql`substr(${column}, 1, ${sql.raw(String([...prefix].length))}) = ${prefix}`;
}

/** The column is `base` or `base-<anything>`: a handle and its numbered copies. */
export function handleOrNumberedCopy(column: SQLWrapper, base: string): SQL {
    return sql`(${column} = ${base} OR ${startsWithText(column, `${base}-`)})`;
}
