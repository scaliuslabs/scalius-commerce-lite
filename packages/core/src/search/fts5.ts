import {
  getDatabaseProviderCapabilities,
  getDatabaseProviderForClient,
  type Database,
} from "@scalius/database/client";
import { and, or, sql, type SQL } from "drizzle-orm";

const FTS5_SPECIAL_CHARS = /["\-*(){}[\]^~:\\/<>|@#&+!?.,'=\u0964\u0965]/g;
const MAX_SEARCH_TOKENS = 8;

function sanitizeSearchTokens(input: string): string[] {
  const cleaned = input.replace(FTS5_SPECIAL_CHARS, " ").trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);
}

/**
 * Sanitize user input for use in an FTS5 MATCH expression.
 * Strips special characters, splits into words, appends * for prefix matching,
 * and joins with spaces (implicit AND — all words must match).
 * Returns empty string if input is empty or contains no valid tokens.
 */
export function sanitizeFtsQuery(input: string): string {
  const tokens = sanitizeSearchTokens(input).map((token) => `${token}*`);

  return tokens.length > 0 ? tokens.join(" ") : "";
}

// Allowlist of valid FTS5 table names to prevent SQL injection
const ALLOWED_FTS_TABLES = [
  "products_fts", "product_variants_fts", "categories_fts",
  "pages_fts", "orders_fts", "customers_fts",
  "discounts_fts", "abandoned_checkouts_fts",
  "navigation_menu_items_fts",
] as const;
type FtsTable = typeof ALLOWED_FTS_TABLES[number];

const ALLOWED_SOURCE_TABLES = [
  "products", "product_variants", "categories",
  "pages", "orders", "customers",
  "discounts", "abandoned_checkouts",
  "navigation_menu_items",
] as const;
type SourceTable = typeof ALLOWED_SOURCE_TABLES[number];

const FALLBACK_SEARCH_COLUMNS: Record<SourceTable, readonly string[]> = {
  products: ["name", "description"],
  product_variants: ["sku"],
  categories: ["name", "description"],
  pages: ["title", "content"],
  orders: ["customer_name", "customer_phone", "customer_email", "id"],
  customers: ["name", "phone", "email"],
  discounts: ["code"],
  abandoned_checkouts: ["customer_phone", "checkout_id", "checkout_data"],
  navigation_menu_items: ["label", "target_value", "target_id"],
};

export function isFts5SearchEnabled(db: Database): boolean {
  return getDatabaseProviderCapabilities(
    getDatabaseProviderForClient(db),
  ).fts5;
}

function fallbackSearchMatch(
  sourceTable: SourceTable,
  query: string,
  column?: string,
): SQL | undefined {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return undefined;
  const columns = column ? [column] : FALLBACK_SEARCH_COLUMNS[sourceTable];
  const tokenConditions = tokens.map((token) =>
    or(...columns.map((column) =>
      sql`instr(lower(coalesce(${sql.raw(`${sourceTable}.${column}`)}, '')), lower(${token})) > 0`,
    )),
  ).filter((condition): condition is SQL => Boolean(condition));
  return tokenConditions.length > 0 ? and(...tokenConditions) : undefined;
}

/**
 * Build a Drizzle SQL condition that filters rows by FTS5 MATCH.
 * Returns `undefined` when the query is empty/invalid (caller should skip the condition).
 *
 * Table names are restricted to an allowlist at both compile-time and runtime.
 * The match value is parameterized.
 *
 * Usage:
 *   const cond = ftsMatch(db, "products_fts", "products", searchTerm);
 *   if (cond) conditions.push(cond);
 */
export function ftsMatch(
  db: Database,
  ftsTable: FtsTable,
  sourceTable: SourceTable,
  query: string,
  options: { column?: string } = {},
): SQL | undefined {
  // Runtime validation as defense-in-depth
  if (!(ALLOWED_FTS_TABLES as readonly string[]).includes(ftsTable)) {
    throw new Error(`Invalid FTS table: ${ftsTable}`);
  }
  if (!(ALLOWED_SOURCE_TABLES as readonly string[]).includes(sourceTable)) {
    throw new Error(`Invalid source table: ${sourceTable}`);
  }
  if (
    options.column &&
    !FALLBACK_SEARCH_COLUMNS[sourceTable].includes(options.column)
  ) {
    throw new Error(`Invalid search column for ${sourceTable}: ${options.column}`);
  }

  if (!isFts5SearchEnabled(db)) {
    return fallbackSearchMatch(sourceTable, query, options.column);
  }

  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return undefined;
  const matchQuery = options.column
    ? `${options.column} : (${sanitized})`
    : sanitized;
  return sql`${sql.raw(sourceTable)}.rowid IN (SELECT rowid FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${matchQuery})`;
}
