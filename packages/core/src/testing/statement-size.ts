// Test-only: how close a statement comes to SQLite's nesting limits.
//
// SQLite 3.54.1 (workerd 1.20261106.1, cloudflare/workerd#8347) counted a
// statement's cursors against its nesting limit of 100 and refused the old
// one-statement Analytics overview (highest cursor 129) with "VIEWs and/or
// subqueries nested too deep". Production D1 runs whatever SQLite Cloudflare
// deploys, so every statement keeps a wide margin under that limit by
// construction: a statement near the bound is split into smaller ones sent
// in one batch, not made to squeeze under it.
import type { DatabaseSync } from "node:sqlite";

/**
 * The most a statement may reach in its highest cursor number (EXPLAIN): 40
 * under the 100 SQLite 3.54.1 enforced. The live reports' line and refund
 * chain sits at 31 to 60; the overview's statements at most 24.
 */
export const STATEMENT_CURSOR_BOUND = 60;
/** The most common table expressions one statement may define (the live reports' chain plus their own). */
export const STATEMENT_CTE_BOUND = 12;

const OPENS_CURSOR = /^(?:Open\w+|SorterOpen|ReopenIdx|VOpen)$/;
const CTE_DEFINITION = /(?:\bwith\s+(?:recursive\s+)?|,\s*)"?[a-z_]\w*"?(?:\s*\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi;

export interface StatementSize {
  query: string;
  /** The highest cursor number its program opens (the measure the engine bug used). */
  cursors: number;
  ctes: number;
  /** FROM/JOIN references to its CTEs: the regression tracked CTE references, so this orders real risk. */
  cteReferences: number;
}

/** The highest cursor number `query`'s program opens: p1 of every cursor-opening opcode of `EXPLAIN`. */
export function highestCursor(sqlite: DatabaseSync, query: string): number {
  const program = sqlite.prepare(`EXPLAIN ${query}`).all() as Array<{ opcode: string; p1: number | bigint }>;
  return program.reduce((max, step) => OPENS_CURSOR.test(step.opcode) ? Math.max(max, Number(step.p1)) : max, -1);
}

/** The common table expressions `query` defines (text measure: `with name as (`, `, name as materialized (`). */
export function cteCount(query: string): number {
  return query.match(CTE_DEFINITION)?.length ?? 0;
}

/** The CTE names `query` defines. */
export function cteNames(query: string): string[] {
  return [...query.matchAll(CTE_DEFINITION)].map((match) => /"?([a-z_]\w*)"?(?:\s*\([^()]*\))?\s+as\s/i.exec(match[0].replace(/^\s*(?:with\s+(?:recursive\s+)?|,)\s*/i, ""))?.[1] ?? "");
}

/** How many FROM/JOIN items of `query` name one of its CTEs. */
export function cteReferenceCount(query: string): number {
  return cteNames(query).filter(Boolean).reduce((total, name) =>
    total + (query.match(new RegExp(`\\b(?:from|join)\\s+"?${name}"?(?![\\w"])`, "gi"))?.length ?? 0), 0);
}

/** Each distinct statement's size, largest first. Statements SQLite cannot prepare here (`EXPLAIN`, `PRAGMA`) are skipped. */
export function statementSizes(sqlite: DatabaseSync, queries: Iterable<string>): StatementSize[] {
  const sizes: StatementSize[] = [];
  for (const query of new Set(queries)) {
    if (/^\s*(?:explain|pragma|begin|commit|rollback|savepoint|release)\b/i.test(query)) continue;
    sizes.push({ query, cursors: highestCursor(sqlite, query), ctes: cteCount(query), cteReferences: cteReferenceCount(query) });
  }
  return sizes.sort((left, right) => right.cursors - left.cursors || right.ctes - left.ctes);
}

/** Statements over either bound, as `cursors/ctes: first 160 characters` lines (empty when all fit). */
export function oversizedStatements(sizes: readonly StatementSize[]): string[] {
  return sizes
    .filter((size) => size.cursors > STATEMENT_CURSOR_BOUND || size.ctes > STATEMENT_CTE_BOUND)
    .map((size) => `${size.cursors}/${size.ctes}: ${size.query.replace(/\s+/g, " ").slice(0, 160)}`);
}

/** A table of the largest statements (cursors, CTEs, CTE references, text), for a report file. */
export function sizeTable(sizes: readonly StatementSize[], top = 10): string {
  return sizes.slice(0, top)
    .map((size) => `${String(size.cursors).padStart(4)} ${String(size.ctes).padStart(3)} ${String(size.cteReferences).padStart(3)}  ${size.query.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");
}
