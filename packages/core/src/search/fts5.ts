import { sql, type SQL } from "drizzle-orm";

const FTS5_SPECIAL_CHARS = /["\-*(){}[\]^~:\\/<>|@#&+!?.,'=\u0964\u0965]/g;

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

// Allowlist of valid FTS5 table names to prevent SQL injection
const ALLOWED_FTS_TABLES = [
  "products_fts", "product_variants_fts", "categories_fts",
  "pages_fts", "orders_fts", "customers_fts",
  "discounts_fts", "abandoned_checkouts_fts",
] as const;
type FtsTable = typeof ALLOWED_FTS_TABLES[number];

const ALLOWED_SOURCE_TABLES = [
  "products", "product_variants", "categories",
  "pages", "orders", "customers",
  "discounts", "abandoned_checkouts",
] as const;
type SourceTable = typeof ALLOWED_SOURCE_TABLES[number];

/**
 * Build a Drizzle SQL condition that filters rows by FTS5 MATCH.
 * Returns `undefined` when the query is empty/invalid (caller should skip the condition).
 *
 * Table names are restricted to an allowlist at both compile-time and runtime.
 * The match value is parameterized.
 *
 * Usage:
 *   const cond = ftsMatch("products_fts", "products", searchTerm);
 *   if (cond) conditions.push(cond);
 */
export function ftsMatch(
  ftsTable: FtsTable,
  sourceTable: SourceTable,
  query: string,
): SQL | undefined {
  // Runtime validation as defense-in-depth
  if (!(ALLOWED_FTS_TABLES as readonly string[]).includes(ftsTable)) {
    throw new Error(`Invalid FTS table: ${ftsTable}`);
  }
  if (!(ALLOWED_SOURCE_TABLES as readonly string[]).includes(sourceTable)) {
    throw new Error(`Invalid source table: ${sourceTable}`);
  }

  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return undefined;
  return sql`${sql.raw(sourceTable)}.rowid IN (SELECT rowid FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${sanitized})`;
}
