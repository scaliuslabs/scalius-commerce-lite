import { sql, type SQL } from "drizzle-orm";

const FTS5_SPECIAL_CHARS = /["\-*(){}[\]^~:\\/<>|@#&+!?.,'=]/g;

/**
 * Sanitize user input for use in an FTS5 MATCH expression.
 * Strips special characters, splits into words, appends * for prefix matching,
 * and joins with spaces (implicit AND — all words must match).
 * Returns empty string if input is empty or contains no valid tokens.
 */
export function sanitizeFtsQuery(input: string): string {
  const cleaned = input.replace(FTS5_SPECIAL_CHARS, " ").trim();
  if (!cleaned) return "";

  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `${t}*`);

  return tokens.length > 0 ? tokens.join(" ") : "";
}

/**
 * Build a Drizzle SQL condition that filters rows by FTS5 MATCH.
 * Returns `undefined` when the query is empty/invalid (caller should skip the condition).
 *
 * Table names are safe (hardcoded by callers), the match value is parameterized.
 *
 * Usage:
 *   const cond = ftsMatch("products_fts", "products", searchTerm);
 *   if (cond) conditions.push(cond);
 */
export function ftsMatch(
  ftsTable: string,
  sourceTable: string,
  query: string,
): SQL | undefined {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return undefined;
  return sql`${sql.raw(sourceTable)}.rowid IN (SELECT rowid FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${sanitized})`;
}
