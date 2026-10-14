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

/** The rows of the index in one term's range (one index range scan each). */
function termRows(columns: SQL, source: SearchSource, term: IndexTerm, col: number | undefined): SQL {
  return sql`SELECT ${columns} FROM ${INDEX} WHERE source = ${source}${col === undefined ? sql`` : sql` AND col = ${col}`} AND ${termCondition(term)}`;
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
 * Every row of `source` matching `query`, with its FTS5 bm25 score
 * (`rank_score`, lower is better; `weights` per column, else 1 each), as one
 * derived table `alias` the caller LEFT JOINs on `on`. Undefined when the
 * query has no word.
 *
 * D1: FTS5's own bm25; `LIMIT -1` keeps SQLite from flattening the set back
 * into a per-row MATCH. Search index: the same formula over the same counts
 * (k1 1.2, b 0.75; idf from the rows each word matches, the row count and
 * the average row length), read in one pass over each word's term range.
 */
export function searchRankJoin(
  db: Database,
  source: SearchSource,
  query: string,
  options: { alias: string; weights?: readonly number[] },
): { table: SQL; on: SQL; score: SQL } | undefined {
  const alias = sql.raw(options.alias);
  const score = sql.raw(`COALESCE(${options.alias}.rank_score, 0)`);
  const keyColumn = sql.raw(`${options.alias}.rank_key = "${source}".${searchKeyColumn(db)}`);
  if (isFts5SearchEnabled(db)) {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return undefined;
    const fts = sql.raw(`${source}_fts`);
    const bm25 = options.weights ? sql.raw(`bm25(${source}_fts, ${options.weights.map((weight) => weight.toFixed(1)).join(", ")})`) : sql.raw("rank");
    return {
      table: sql`(SELECT rowid AS rank_key, ${bm25} AS rank_score FROM ${fts} WHERE ${fts} MATCH ${sanitized} LIMIT -1) AS ${alias}`,
      on: keyColumn,
      score,
    };
  }
  const words = indexQuery(query);
  if (!words) return undefined;
  // Each term of a split word scores as its own phrase (FTS5 scores the phrase).
  const terms = words.flat().map((term) => [term]);
  if (terms.length === 0) {
    return { table: sql`(SELECT NULL AS rank_key, 0 AS rank_score WHERE 0 = 1) AS ${alias}`, on: keyColumn, score };
  }
  const weights = options.weights;
  const weighted = weights && weights.some((value) => value !== 1)
    ? `CASE col ${weights.map((value, column) => `WHEN ${column} THEN ${value.toFixed(1)}`).join(" ")} ELSE 1.0 END * tf`
    : "tf";
  // One range scan per word: its weighted count in its own column, 0 in the others.
  const instances = sql.join(terms.map((word, position) => termRows(
    sql.raw(["doc_id", ...terms.map((_, other) => `${other === position ? weighted : "0"} AS f${other}`)].join(", ")),
    source,
    word[0]!,
    undefined,
  )), sql` UNION ALL `);
  const sums = terms.map((_, position) => `CAST(sum(f${position}) AS float) AS f${position}`).join(", ");
  const hits = terms.map((_, position) => `sum(CASE WHEN f${position} > 0 THEN 1 ELSE 0 END) OVER () AS h${position}`).join(", ");
  // FTS5: score = -sum(idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * D / avgdl))), idf = ln((N - n + 0.5) / (n + 0.5)) or 1e-6.
  const bm25 = terms.map((_, position) => {
    const idf = `max(ln(CAST(stats.row_count - m.h${position} + 0.5 AS float) / (m.h${position} + 0.5)), 0.000001)`;
    return `${idf} * (m.f${position} * (1.2 + 1.0)) / (m.f${position} + 1.2 * (1 - 0.75 + 0.75 * doc.tf / stats.avgdl))`;
  }).join(" + ");
  return {
    table: sql`(
      SELECT m.doc_id AS rank_key, ${sql.raw(`-(${bm25})`)} AS rank_score
      FROM (
        SELECT matched.*, ${sql.raw(hits)}
        FROM (SELECT doc_id, ${sql.raw(sums)} FROM (${instances}) AS instances GROUP BY doc_id) AS matched
      ) AS m
      INNER JOIN ${INDEX} AS doc ON doc.source = ${source} AND doc.term = '' AND doc.col = -1 AND doc.doc_id = m.doc_id
      CROSS JOIN (
        SELECT count(*) AS row_count, CAST(sum(tf) AS float) / count(*) AS avgdl
        FROM ${INDEX} WHERE source = ${source} AND term = '' AND col = -1
      ) AS stats
      WHERE ${sql.raw(terms.map((_, position) => `m.f${position} > 0`).join(" AND "))}
    ) AS ${alias}`,
    on: keyColumn,
    score,
  };
}
