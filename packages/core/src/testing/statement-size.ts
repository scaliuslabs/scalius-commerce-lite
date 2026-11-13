// Test-only: how close a statement comes to the limit SQLite puts on CTE expansion.
//
// SQLite 3.54.1 (workerd 1.20261106.1 to 1.20261110.1) refused a statement
// with "VIEWs and/or subqueries nested too deep" when, as it expanded a
// reference to a common table expression, the cursors the statement had
// already allocated (`pParse->nTab`) reached the expression-depth limit,
// which D1 sets to 100 (select.c, withExpand, "Bug 2026-10-04": a guard
// against nested CTEs allocating an exponential number of cursors). SQLite's
// trunk keeps the same test as its own limit, SQLITE_LIMIT_CTES ("too many
// CTEs"). A statement without a CTE never reaches it.
//
// The engine counts cursors allocated, not opened: every CTE reference
// expands its body again and allocates its cursors, even when a materialized
// CTE then codes one copy (seven materialized CTEs each reading the one
// before twice open 12 cursors and are refused). The measure (`cteCursors`)
// wraps the statement in `select * from (...) order by random()`: that ORDER
// BY's sorter takes the next cursor number once the whole statement is
// expanded and resolved, so its number is every cursor allocated by then, at
// least what the last CTE expansion saw. Against the 3.54.1 engine
// (workerd 1.20261110.1) the statements it refused measured 101 to 1,024 and
// those it accepted up to 108 (one CTE read 50 times: 151): an upper bound.
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** D1's expression-depth limit, the cursor count 3.54.1 refused a CTE expansion at. */
export const CTE_CURSOR_LIMIT = 100;
/** The most a statement with a CTE may measure (`cteCursors`): 40 under the limit the engine refused at. */
export const CTE_CURSOR_BOUND = 60;

const OPENS_CURSOR = /^(?:Open\w+|SorterOpen|ReopenIdx|VOpen)$/;
const CTE_DEFINITION = /(?:\bwith\s+(?:recursive\s+)?|,\s*)"?[a-z_]\w*"?(?:\s*\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi;

export interface StatementSize {
  query: string;
  /** Cursors allocated once the statement is expanded (see the file comment); 0 without a CTE. */
  cteCursors: number;
  /** The highest cursor number the statement as written opens. */
  cursors: number;
  ctes: number;
  /** FROM/JOIN references to its CTEs: each expands the CTE's body again. */
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

/** `query` with every CTE inlined at each reference: each expanded copy is coded and opens its cursors. */
export function inlineCtes(query: string): string {
  return query
    .replace(/\bas\s+materialized\s*\(/gi, "as not materialized (")
    .replace(/(\b\w+"?\s+as\s+)\(/gi, "$1not materialized (");
}

/** The SELECT of an `INSERT ... SELECT` (its conflict clause dropped), or the statement itself. */
function selectOf(query: string): string {
  return query
    .replace(/^\s*insert\s+(?:or\s+\w+\s+)?into\s+"?\w+"?\s*\([^)]*\)\s*/i, "")
    .replace(/\s+on\s+conflict\b[\s\S]*$/i, "");
}

/**
 * Cursors the statement has allocated once expanded and resolved, 0 without a
 * CTE. Another statement with a CTE (an UPDATE or DELETE) takes the
 * every-copy-coded count, which can only overstate it.
 */
export function cteCursorCount(sqlite: DatabaseSync, query: string): number {
  if (cteCount(query) === 0) return 0;
  const select = selectOf(query);
  if (/^\s*(?:with|select|values)\b/i.test(select)) {
    const program = sqlite.prepare(`EXPLAIN select * from (${select}) as statement_size_probe order by random()`).all() as Array<{ opcode: string; p1: number | bigint }>;
    const sorter = program.find((step) => step.opcode === "SorterOpen");
    if (sorter) return Number(sorter.p1);
  }
  return highestCursor(sqlite, inlineCtes(query));
}

const NOT_MEASURED = /^\s*(?:explain|pragma|begin|commit|rollback|savepoint|release|create|drop|alter|attach|detach|vacuum|analyze)\b/i;

/** One statement's size. */
export function statementSize(sqlite: DatabaseSync, query: string): StatementSize {
  return {
    query,
    cteCursors: cteCursorCount(sqlite, query),
    cursors: highestCursor(sqlite, query),
    ctes: cteCount(query),
    cteReferences: cteReferenceCount(query),
  };
}

/** Each distinct statement's size, largest first. Statements that are not reads or writes (`EXPLAIN`, `PRAGMA`, DDL) are skipped. */
export function statementSizes(sqlite: DatabaseSync, queries: Iterable<string>): StatementSize[] {
  const sizes: StatementSize[] = [];
  for (const query of new Set(queries)) {
    if (NOT_MEASURED.test(query)) continue;
    sizes.push(statementSize(sqlite, query));
  }
  return sizes.sort((left, right) => right.cteCursors - left.cteCursors || right.cteReferences - left.cteReferences);
}

/** A statement's name in a census: its first CTE, else the table its outer SELECT reads, else its verb and target. */
export function statementLabel(query: string): string {
  const cte = /^\s*with\s+(?:recursive\s+)?"?(\w+)"?/i.exec(query)?.[1];
  if (cte) return `with ${cte}`;
  const table = /^\s*select\s+"(\w+)"\."/i.exec(query)?.[1];
  if (table) return `select ${table}`;
  const wrapped = /^\s*select\s+\w+\.\w+[\s\S]*?\bfrom\s*\(\s*with\s+"?(\w+)"?/i.exec(query)?.[1];
  if (wrapped) return `select (with ${wrapped})`;
  const target = /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|from)\s+"?(\w+)"?/i.exec(query)?.[1];
  return `${/^\s*(\w+)/.exec(query)?.[1]?.toLowerCase() ?? "?"} ${target ?? "?"}`;
}

/** The largest of a census key's statements, each maximum taken on its own. */
export interface CensusEntry {
  cteCursors: number;
  cteReferences: number;
  cursors: number;
  ctes: number;
  /** The statement with the most CTE cursors. */
  query: string;
  /** Distinct statements under this key. */
  statements: number;
}

export interface StatementCensus {
  /** `source | label` (see `statementLabel`) to its statements' maxima. */
  readonly entries: Map<string, CensusEntry>;
  /** Adds one statement under `source` (a statement prepared elsewhere, a trigger body). */
  add(sqlite: DatabaseSync, query: string, source: string): void;
  stop(): void;
}

/**
 * Records every statement any node:sqlite database prepares from now on
 * (the test D1, Turso shim and harness writes alike), measured on the
 * database that prepared it, under `source()` (a route, a scenario).
 */
export function recordStatementCensus(source: () => string = () => ""): StatementCensus {
  const prototype = DatabaseSync.prototype as unknown as { prepare(this: DatabaseSync, sql: string, ...rest: unknown[]): unknown };
  const original = prototype.prepare;
  const entries = new Map<string, CensusEntry>();
  const seen = new Set<string>();
  let measuring = false;
  const add = (sqlite: DatabaseSync, query: string, from: string) => {
    if (NOT_MEASURED.test(query) || seen.has(`${from}\u0000${query}`)) return;
    seen.add(`${from}\u0000${query}`);
    let size: StatementSize;
    measuring = true;
    try {
      size = statementSize(sqlite, query);
    } catch {
      return; // A statement this database cannot plan (a dropped table): its own run fails louder.
    } finally {
      measuring = false;
    }
    const key = `${from} | ${statementLabel(query)}`;
    const known = entries.get(key);
    entries.set(key, {
      cteCursors: Math.max(known?.cteCursors ?? 0, size.cteCursors),
      cteReferences: Math.max(known?.cteReferences ?? 0, size.cteReferences),
      cursors: Math.max(known?.cursors ?? 0, size.cursors),
      ctes: Math.max(known?.ctes ?? 0, size.ctes),
      query: known && known.cteCursors >= size.cteCursors ? known.query : query,
      statements: (known?.statements ?? 0) + 1,
    });
  };
  prototype.prepare = function prepare(this: DatabaseSync, sql: string, ...rest: unknown[]) {
    const statement = original.call(this, sql, ...rest);
    if (!measuring && typeof sql === "string") add(this, sql, source());
    return statement;
  };
  return {
    entries,
    add,
    stop: () => {
      prototype.prepare = original;
      // STATEMENT_CENSUS_DUMP=<file> appends the keys past half the bound (JSON lines), with their statement.
      const dump = process.env.STATEMENT_CENSUS_DUMP;
      if (dump) for (const [key, entry] of entries) if (entry.cteCursors > CTE_CURSOR_BOUND / 2) appendFileSync(dump, `${JSON.stringify({ key, ...entry })}\n`);
    },
  };
}

/**
 * What a census breaks: a key over the bound that `pending` does not list, a
 * listed key whose CTE cursors or CTE references grew, and an entry of
 * `required` (default: none) that now fits, so it is removed. `byLabel`
 * matches entries by statement label alone (the largest listed), for flows
 * whose sources are not the listed routes.
 */
export function censusProblems(
  entries: ReadonlyMap<string, CensusEntry>,
  pending: Readonly<Record<string, readonly [cteCursors: number, cteReferences: number]>>,
  options: { byLabel?: boolean; required?: Readonly<Record<string, unknown>> } = {},
): string[] {
  const nameOf = (key: string) => options.byLabel ? key.slice(key.lastIndexOf(" | ") + 3) : key;
  const allowance = new Map<string, readonly [number, number]>();
  for (const [key, [cursors, references]] of Object.entries(pending)) {
    const known = allowance.get(nameOf(key));
    allowance.set(nameOf(key), [Math.max(known?.[0] ?? 0, cursors), Math.max(known?.[1] ?? 0, references)]);
  }
  const problems: string[] = [];
  const over = new Set<string>();
  for (const [key, entry] of entries) {
    if (entry.cteCursors <= CTE_CURSOR_BOUND) continue;
    over.add(nameOf(key));
    const allowed = allowance.get(nameOf(key));
    if (!allowed) problems.push(`over the bound: ${key} (${entry.cteCursors} CTE cursors, ${entry.cteReferences} CTE references): ${entry.query.replace(/\s+/g, " ").slice(0, 120)}`);
    else if (entry.cteCursors > allowed[0] || entry.cteReferences > allowed[1]) problems.push(`grew: ${key} (${entry.cteCursors}/${entry.cteReferences}, pending ${allowed[0]}/${allowed[1]})`);
  }
  for (const key of Object.keys(options.required ?? {})) {
    if (!over.has(nameOf(key))) problems.push(`now fits, remove it from PENDING: ${key}`);
  }
  return problems;
}

/** Statements over the bound, as `cteCursors/cteReferences: first 160 characters` lines (empty when all fit). */
export function oversizedStatements(sizes: readonly StatementSize[]): string[] {
  return sizes
    .filter((size) => size.cteCursors > CTE_CURSOR_BOUND)
    .map((size) => `${size.cteCursors}/${size.cteReferences}: ${size.query.replace(/\s+/g, " ").slice(0, 160)}`);
}

/** A table of the largest statements (CTE cursors, cursors, CTEs, CTE references, text), for a report file. */
export function sizeTable(sizes: readonly StatementSize[], top = 10): string {
  return sizes.slice(0, top)
    .map((size) => `${[size.cteCursors, size.cursors, size.ctes, size.cteReferences].map((n) => String(n).padStart(4)).join(" ")}  ${size.query.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");
}
