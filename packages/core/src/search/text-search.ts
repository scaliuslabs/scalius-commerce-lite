// Text search over each provider's index, with one result on every provider:
// D1 matches its FTS5 tables; Turso and PostgreSQL match the search index
// (`@scalius/database/search-index`), which stores FTS5's tokens and counts.
// A query word matches a token it starts, every word must match, and ranks
// are FTS5's bm25 on both (docs/DATABASE-PORTABILITY.md, Text search).
import {
  getDatabaseProviderCapabilities,
  getDatabaseProviderForClient,
  type Database,
} from "@scalius/database/client";
import {
  SEARCH_INDEX_TABLE,
  SEARCH_SOURCES,
  searchTerms,
  type SearchSource,
} from "@scalius/database/search-index";
import { sql, type SQL } from "drizzle-orm";

export type { SearchSource };

// Every ASCII character outside an FTS5 bareword (letters, digits, `_`) and
// the Bangla danda: a stray `%`, `$` or `;` would otherwise be an FTS5 syntax
// error, not a search.
const FTS5_SPECIAL_CHARS = /[\p{Cc}\x20-\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7E।॥]/gu;
const MAX_SEARCH_TOKENS = 8;

/**
 * Splits buyer/admin input into bounded search tokens. Input is NFC-normalized
 * first so Bangla typed through different keyboards (for example a precomposed
 * or decomposed য়) produces one token form.
 */
export function sanitizeSearchTokens(input: string): string[] {
  const cleaned = input.normalize("NFC").replace(FTS5_SPECIAL_CHARS, " ").trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);
}

/**
 * The FTS5 MATCH expression of the input: each token a prefix, all required
 * (implicit AND). Empty when the input has no token.
 */
export function sanitizeFtsQuery(input: string): string {
  const tokens = sanitizeSearchTokens(input).map((token) => `${token}*`);
  return tokens.length > 0 ? tokens.join(" ") : "";
}

/** D1 searches its FTS5 tables; Turso and PostgreSQL the search index. */
export function isFts5SearchEnabled(db: Database): boolean {
  return getDatabaseProviderCapabilities(getDatabaseProviderForClient(db)).fts5;
}

/** The column a key set (`searchKeys`) selects: the FTS5 rowid, or the row id. */
export function searchKeyColumn(db: Database): "rowid" | "id" {
  return isFts5SearchEnabled(db) ? "rowid" : "id";
}

/** One index term: a whole token, or (`prefix`) every token it starts. */
interface IndexTerm {
  term: string;
  prefix: boolean;
}

/**
 * The words of a query, all required (AND). A word is the terms of one query
 * token: one, or more when a separator splits it (FTS5 reads them as a
 * phrase; the index requires them in one column, without their adjacency).
 */
type IndexQuery = IndexTerm[][];

function columnIndex(source: SearchSource, column: string | undefined): number | undefined {
  if (column === undefined) return undefined;
  const index = SEARCH_SOURCES[source].findIndex(([fts5Column]) => fts5Column === column);
  if (index < 0) throw new Error(`Invalid search column for ${source}: ${column}`);
  return index;
}

/**
 * The index terms of buyer/admin input, as FTS5 reads `token*`: each token's
 * words (a non-ASCII separator inside a token splits it, as FTS5 splits it
 * into a phrase), the last a prefix. Null when the input has no token, and
 * [] when a token has no word (FTS5 then matches nothing).
 */
function indexQuery(input: string): IndexQuery | null {
  const tokens = sanitizeSearchTokens(input);
  if (tokens.length === 0) return null;
  const query: IndexQuery = [];
  for (const token of tokens) {
    const words = searchTerms(token);
    if (words.length === 0) return [];
    query.push(words.map((term, index) => ({ term, prefix: index === words.length - 1 })));
  }
  return query;
}

/** The smallest string after every string `prefix` starts (code point order: SQLite BINARY, PostgreSQL "C"). */
function prefixEnd(prefix: string): string {
  const points = Array.from(prefix);
  const last = points.pop()!.codePointAt(0)!;
  return points.join("") + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
}

function termCondition({ term, prefix }: IndexTerm): SQL {
  return prefix ? sql`term >= ${term} AND term < ${prefixEnd(term)}` : sql`term = ${term}`;
}

const INDEX = sql.raw(SEARCH_INDEX_TABLE);
// SQLite reads a term range or a row's terms through the index named here: inside an IN or a
// UNION it would scan a whole source on the doc index for its doc id order. PostgreSQL drops the hint.
const BY_TERM = sql.raw(`${SEARCH_INDEX_TABLE} AS t INDEXED BY ${SEARCH_INDEX_TABLE}_term_idx`);
const BY_DOC = sql.raw(`${SEARCH_INDEX_TABLE} AS d INDEXED BY ${SEARCH_INDEX_TABLE}_doc_idx`);

/** The rows of the index in one term's range (one index range scan each). */
function termRows(columns: SQL, source: SearchSource, term: IndexTerm, col: number | undefined): SQL {
  return sql`SELECT ${columns} FROM ${BY_TERM} WHERE source = ${source}${col === undefined ? sql`` : sql` AND col = ${col}`} AND ${termCondition(term)}`;
}

/**
 * The doc ids that match every word (INTERSECT); a split word's terms meet
 * in one column (doc and column pairs INTERSECT). One SELECT per term range
 * keeps every planner on index ranges, where an OR of ranges may scan the
 * whole source.
 */
function indexKeys(source: SearchSource, query: IndexQuery, col: number | undefined): SQL {
  if (query.length === 0) return sql`SELECT doc_id FROM ${INDEX} WHERE 0 = 1`;
  return sql.join(query.map((terms) => terms.length === 1
    ? termRows(sql`doc_id`, source, terms[0]!, col)
    : sql`SELECT doc_id FROM (${sql.join(terms.map((term) => termRows(sql`doc_id, col`, source, term, col)), sql` INTERSECT `)}) AS phrase`), sql` INTERSECT `);
}

/**
 * The keys (`searchKeyColumn`) of the rows of `source` whose text (or one
 * column, by its FTS5 name) has every word of `query`. Undefined when the
 * query has no word.
 */
export function searchKeys(db: Database, source: SearchSource, query: string, options: { column?: string } = {}): SQL | undefined {
  const col = columnIndex(source, options.column);
  if (isFts5SearchEnabled(db)) {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return undefined;
    const match = options.column ? `${options.column} : (${sanitized})` : sanitized;
    return sql`SELECT rowid FROM ${sql.raw(`${source}_fts`)} WHERE ${sql.raw(`${source}_fts`)} MATCH ${match}`;
  }
  const terms = indexQuery(query);
  return terms ? indexKeys(source, terms, col) : undefined;
}

/**
 * The keys of the rows of `source` whose `column` has a token that starts
 * with one of `prefixes` (digits only: a phone in any of its forms, so the
 * FTS5 query needs no escaping). A stored "+880 1712-345678" is several
 * tokens, so it matches from its first group only.
 */
export function searchPrefixKeys(db: Database, source: SearchSource, column: string, prefixes: readonly string[]): SQL {
  const col = columnIndex(source, column);
  if (isFts5SearchEnabled(db)) {
    const match = `${column} : (${prefixes.map((digits) => `${digits}*`).join(" OR ")})`;
    return sql`SELECT rowid FROM ${sql.raw(`${source}_fts`)} WHERE ${sql.raw(`${source}_fts`)} MATCH ${match}`;
  }
  return sql`SELECT doc_id FROM (${sql.join(prefixes.map((term) => termRows(sql`doc_id`, source, { term, prefix: true }, col)), sql` UNION ALL `)}) AS alternatives`;
}

/**
 * The rows of `source` whose text (or one column) has every word of `query`,
 * as a condition on `source`. Undefined when the query has no word.
 */
export function searchMatch(db: Database, source: SearchSource, query: string, options: { column?: string } = {}): SQL | undefined {
  const keys = searchKeys(db, source, query, options);
  return keys ? sql`${sql.raw(source)}.${sql.raw(searchKeyColumn(db))} IN (${keys})` : undefined;
}

/**
 * The FTS5 bm25 score (lower is better; `weights` per column, else 1 each)
 * of each row of `source` that matches every word of `query`, 0 for any
 * other row: `score`, an expression over the row. Undefined when the query
 * has no word.
 *
 * D1: FTS5's own bm25, as one derived table the caller LEFT JOINs (`join`;
 * `LIMIT -1` keeps SQLite from flattening it back into a per-row MATCH).
 *
 * Search index: the same formula over the same counts (k1 1.2, b 0.75; idf
 * from the rows each word matches, the row count and the average row
 * length). The per-query constants are one row the caller LEFT JOINs
 * (`join`, on 1 = 1); per row, one doc-index seek per word and for its
 * length. A derived table of every match's score left PostgreSQL to
 * estimate its rows (a prefix range over millions of terms), and a 1-row
 * estimate planned a quadratic nested loop (2.3 s).
 */
export function searchRank(
  db: Database,
  source: SearchSource,
  query: string,
  options: { alias: string; weights?: readonly number[] },
): { join?: { table: SQL; on: SQL }; score: SQL } | undefined {
  if (isFts5SearchEnabled(db)) {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return undefined;
    const fts = sql.raw(`${source}_fts`);
    const bm25 = options.weights ? sql.raw(`bm25(${source}_fts, ${options.weights.map((weight) => weight.toFixed(1)).join(", ")})`) : sql.raw("rank");
    return {
      join: {
        table: sql`(SELECT rowid AS rank_key, ${bm25} AS rank_score FROM ${fts} WHERE ${fts} MATCH ${sanitized} LIMIT -1) AS ${sql.raw(options.alias)}`,
        on: sql.raw(`${options.alias}.rank_key = "${source}".rowid`),
      },
      score: sql.raw(`COALESCE(${options.alias}.rank_score, 0)`),
    };
  }
  const words = indexQuery(query);
  if (!words) return undefined;
  // Each term of a split word scores as its own phrase (FTS5 scores the phrase).
  const terms = words.flat();
  // No term (a word of separators only) matches nothing; a bare 0 would read as an ORDER BY position.
  if (terms.length === 0) return { score: sql`CAST(0 AS float)` };
  const row = sql.raw(`"${source}".id`);
  const weights = options.weights;
  const weighted = sql.raw(weights && weights.some((value) => value !== 1)
    ? `CASE col ${weights.map((value, column) => `WHEN ${column} THEN ${value.toFixed(1)}`).join(" ")} ELSE 1.0 END * tf`
    : "tf");
  const alias = sql.raw(options.alias);
  const constant = (name: string) => sql.raw(`${options.alias}.${name}`);
  const documents = sql`FROM ${BY_TERM} WHERE source = ${source} AND term = '' AND col = -1`;
  const length = sql`(SELECT tf FROM ${BY_DOC} WHERE source = ${source} AND doc_id = ${row} AND term = '' AND col = -1)`;
  // FTS5: score = -sum(idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * D / avgdl))), idf = ln((N - n + 0.5) / (n + 0.5)) or 1e-6.
  // The per-query constants (each word's idf, the average row length) are one row, read once
  // (`LIMIT 1` keeps SQLite from inlining it, where a nested evaluation reran them per row).
  const counts = sql.join([
    sql`(SELECT CAST(count(*) AS float) ${documents}) AS n`,
    sql`(SELECT CAST(sum(tf) AS float) / count(*) ${documents}) AS avgdl`,
    ...terms.map((term, position) => sql`(SELECT count(DISTINCT doc_id) FROM ${BY_TERM} WHERE source = ${source} AND ${termCondition(term)}) AS ${sql.raw(`h${position}`)}`),
  ], sql`, `);
  const idfs = sql.raw(terms.map((_, position) => `max(ln((counts.n - counts.h${position} + 0.5) / (counts.h${position} + 0.5)), 0.000001) AS idf${position}`).join(", "));
  const constants = sql`(SELECT ${idfs}, counts.avgdl AS avgdl FROM (SELECT ${counts} LIMIT 1) AS counts LIMIT 1) AS ${alias}`;
  // Per row, written (k1 + 1) / (1 + k1 * K / f) so each count is read once: one doc-index seek
  // per word and for the length. f 0 (a row that misses a word) makes the score NULL, then 0.
  const parts = terms.map((term, position) => {
    const frequency = sql`(SELECT nullif(CAST(sum(${weighted}) AS float), 0) FROM ${BY_DOC} WHERE source = ${source} AND doc_id = ${row} AND ${termCondition(term)})`;
    return sql`${constant(`idf${position}`)} * (1.2 + 1.0) / (1 + 1.2 * (1 - 0.75 + 0.75 * ${length} / ${constant("avgdl")}) / ${frequency})`;
  });
  return { join: { table: constants, on: sql`1 = 1` }, score: sql`COALESCE(-(${sql.join(parts, sql` + `)}), 0)` };
}
