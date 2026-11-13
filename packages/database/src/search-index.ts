/**
 * The text search index of the providers without FTS5 (Turso, PostgreSQL).
 *
 * D1 searches its FTS5 tables (`<source>_fts`, unicode61). Turso has no FTS5
 * and its own FTS index has no prefix queries, and PostgreSQL's parsers split
 * words differently, so both keep one table, `search_fts_terms`: one row per
 * distinct term of each indexed column of each row, with its count, and one
 * document row (`col` -1, `term` '') with the row's token count. Triggers
 * generated here maintain it from the same sources and columns as the FTS5
 * tables, with FTS5's tokens: every character of the Basic Multilingual
 * Plane folded and split exactly as FTS5's unicode61 (`remove_diacritics 2`)
 * does it, from one map (SEARCH_FOLD_MAP, read from FTS5) that the query
 * side folds with too. Rich-text columns are read without their markup
 * (SEARCH_HTML_COLUMNS), on D1's FTS5 tables as well. A query reads a term
 * prefix as an index range, and ranks with FTS5's bm25 over the same counts
 * (core `search/`).
 *
 * Known differences from FTS5 (docs/DATABASE-PORTABILITY.md, Text search):
 * characters outside the Basic Multilingual Plane (emoji) stay inside a term,
 * a term holds at most 100 characters, and the terms of one query word that a
 * separator splits match in one column without their adjacency.
 *
 * The table name matches `_fts`, so every tool that treats FTS5 tables as
 * derived (exports, imports, schema fingerprints) treats it the same way; an
 * import rebuilds it with `searchIndexRebuildStatements`.
 *
 * Pure SQL text and string functions: no bindings or database access.
 */
import { FTS5_DROPPED_RANGES, FTS5_FOLD_PAIRS, FTS5_SEPARATOR_RANGES } from "./search-fold-data";

export const SEARCH_INDEX_TABLE = "search_fts_terms";

/** The longest term the index keeps; longer words are compared on their first 100 characters. */
export const SEARCH_TERM_MAX_LENGTH = 100;

/**
 * Each FTS5 table's source and columns: `[fts5Column, sourceColumn]`. The
 * column position is the term's `col` and the bm25 weight index.
 */
export const SEARCH_SOURCES = {
  products: [["name", "name"], ["description", "description"]],
  product_variants: [["sku", "sku"]],
  categories: [["name", "name"], ["description", "description"]],
  pages: [["title", "title"], ["content_col", "content"]],
  orders: [["customer_name", "customer_name"], ["customer_phone", "customer_phone"], ["customer_email", "customer_email"], ["order_id", "id"]],
  customers: [["name", "name"], ["phone", "phone"], ["email", "email"]],
  abandoned_checkouts: [["customer_phone", "customer_phone"], ["checkout_id", "checkout_id"], ["checkout_data", "checkout_data"]],
  navigation_menu_items: [["label", "label"], ["target_value", "target_value"], ["target_id", "target_id"]],
  product_reviews: [["title", "title"], ["body", "body"], ["author_display_name", "author_display_name"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

export type SearchSource = keyof typeof SEARCH_SOURCES;

/**
 * The columns that hold rich text (HTML): the index reads their text, not
 * their markup, on every provider (`searchHtmlTextSql`).
 */
export const SEARCH_HTML_COLUMNS: Readonly<Partial<Record<SearchSource, readonly string[]>>> = {
  products: ["description"],
  pages: ["content"],
};

const isHtmlColumn = (source: SearchSource, column: string) => SEARCH_HTML_COLUMNS[source]?.includes(column) ?? false;

/**
 * Every character FTS5 changes and what it becomes: a separator a space, a
 * combining diacritic nothing, a letter its folded letter (search-fold-data.ts,
 * read from FTS5). ASCII capitals are left to `lower()`.
 */
export const SEARCH_FOLD_MAP: ReadonlyMap<string, string> = new Map([
  ...FTS5_SEPARATOR_RANGES.flatMap(([from, to]) => codePoints(from, to).filter((point) => point !== 0x20).map((point) => [String.fromCodePoint(point), " "] as const)),
  ...FTS5_DROPPED_RANGES.flatMap(([from, to]) => codePoints(from, to).map((point) => [String.fromCodePoint(point), ""] as const)),
  ...pairsOf(FTS5_FOLD_PAIRS),
]);

function codePoints(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function pairsOf(text: string): Array<readonly [string, string]> {
  const characters = Array.from(text);
  return Array.from({ length: characters.length / 2 }, (_, index) => [characters[2 * index]!, characters[2 * index + 1]!] as const);
}

/** The text as the index stores it, before it is split on spaces: ASCII lower-cased (SQL `lower()`), then folded as FTS5 folds. */
export function foldSearchText(text: string): string {
  let folded = "";
  for (const character of text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())) {
    folded += SEARCH_FOLD_MAP.get(character) ?? character;
  }
  return folded;
}

/** The terms of a text, in order (a word longer than the cap keeps its first 100 characters). */
export function searchTerms(text: string): string[] {
  return foldSearchText(text).split(" ").filter(Boolean)
    .map((word) => Array.from(word).slice(0, SEARCH_TERM_MAX_LENGTH).join(""));
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const printable = (character: string) => character >= " " && character <= "~";
// Characters outside printable ASCII are written as code points, never raw, in SQL text.
const sqliteCharacter = (character: string) => character === "" ? "''" : printable(character) ? quote(character) : `char(${character.codePointAt(0)})`;
const postgresText = (text: string) => `E'${[...text].map((character) => character === "'" ? "''" : character === "\\" ? "\\\\" : printable(character) ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}'`;

export type SearchIndexDialect = "sqlite" | "postgres";

/**
 * Markup entities a rich-text editor writes, each read as a space (every one
 * names a separator or a space). Their `;` is left: it is a separator too,
 * and a trigger body keeps no `;` inside a literal (migration-plan.test.ts).
 */
const HTML_ENTITIES = ["&nbsp", "&#160", "&amp", "&lt", "&gt", "&quot", "&#34", "&#39", "&apos"] as const;

/**
 * The text of a rich-text (HTML) expression, as the index reads it: every
 * tag (`<` to the next `>`) a space, and the entities an editor writes a
 * space. SQLite has no regular expressions: the text is split on `<` through
 * JSON, and each piece after the first keeps what follows its first `>`.
 * PostgreSQL removes `<[^<>]*>`, which leaves the same words. A tag inside a
 * word splits it, and the text of a `<style>` or `<script>` element stays.
 */
export function searchHtmlTextSql(expression: string, dialect: SearchIndexDialect): string {
  const stripped = dialect === "postgres"
    ? `regexp_replace(${expression}, '<[^<>]*>', ' ', 'g')`
    : `(SELECT group_concat(substr(piece.value, (piece.key > 0) * instr(piece.value, '>') + 1), ' ') FROM json_each('[' || replace(json_quote(${expression}), '<', '","') || ']') AS piece)`;
  return HTML_ENTITIES.reduce((sql, entity) => `replace(${sql}, ${quote(entity)}, ' ')`, stripped);
}

/**
 * SQLite: the folded text of an expression (NULL for NULL or ''), as one
 * scalar subquery of constant size whatever the fold covers. The text is
 * read as UTF-8 bytes; each character (a byte below 0x80 or a lead byte and
 * its continuation bytes) is lower-cased and looked up in the fold table.
 * A replace() chain per folded character nested too deep for SQLite's parser
 * (libSQL refused the schema) and covered only Latin-1.
 */
function sqliteFoldSql(expression: string): string {
  const byte = "substr(text.bytes, position.key + 1, 1)";
  const length = `1 + (${byte} >= x'C0') + (${byte} >= x'E0') + (${byte} >= x'F0')`;
  const characters = `SELECT lower(CAST(substr(text.bytes, position.key + 1, ${length}) AS TEXT)) AS ch`
    // LIMIT 1 keeps the bytes one value; flattened, every character re-read the whole text.
    + ` FROM (SELECT CAST(${expression} AS BLOB) AS bytes LIMIT 1) AS text,`
    + ` json_each('[' || replace(hex(zeroblob(length(text.bytes))), '00', '0,') || '0]') AS position`
    + ` WHERE ${byte} < x'80' OR ${byte} >= x'C0'`;
  return `(SELECT group_concat(coalesce((SELECT fold.folded FROM ${SEARCH_FOLD_TABLE} AS fold WHERE fold.ch = character.ch), character.ch), '') FROM (${characters}) AS character)`;
}

/** The expression the index reads for column `index` of `source` on the row `row` (`NEW` or a source alias). */
function columnSql(source: SearchSource, index: number, row: string, dialect: SearchIndexDialect): string {
  const column = SEARCH_SOURCES[source][index]![1];
  return isHtmlColumn(source, column) ? searchHtmlTextSql(`${row}.${column}`, dialect) : `${row}.${column}`;
}

/** The table the SQLite fold reads: one row per character FTS5 changes (ASCII capitals excepted). */
export const SEARCH_FOLD_TABLE = "search_fts_fold";

/** SQLite: the fold table, emptied and filled from SEARCH_FOLD_MAP (idempotent). */
export function searchFoldTableStatements(): string[] {
  const rows = [...SEARCH_FOLD_MAP].map(([from, to]) => `(${sqliteCharacter(from)}, ${sqliteCharacter(to)})`);
  const inserts: string[] = [];
  for (let index = 0; index < rows.length; index += 500) {
    inserts.push(`INSERT INTO ${SEARCH_FOLD_TABLE} (ch, folded) VALUES ${rows.slice(index, index + 500).join(", ")}`);
  }
  return [
    `CREATE TABLE IF NOT EXISTS ${SEARCH_FOLD_TABLE} (\n  ch text PRIMARY KEY NOT NULL,\n  folded text NOT NULL\n)`,
    `DELETE FROM ${SEARCH_FOLD_TABLE}`,
    ...inserts,
  ];
}

/**
 * PostgreSQL: the fold as one function, a translate() of the whole map (the
 * dropped characters last, with no counterpart, so translate() removes them).
 */
export function searchFoldPostgresFunction(): string {
  const entries = [...SEARCH_FOLD_MAP];
  const kept = entries.filter(([, to]) => to !== "");
  const dropped = entries.filter(([, to]) => to === "");
  const from = [...kept, ...dropped].map(([character]) => character).join("");
  const to = kept.map(([, character]) => character).join("");
  return `CREATE OR REPLACE FUNCTION scalius_compat.${SEARCH_FOLD_TABLE}(value text) RETURNS text\nLANGUAGE sql IMMUTABLE PARALLEL SAFE\nAS $search_fold$ SELECT translate(lower(value COLLATE "C"), ${postgresText(from)}, ${postgresText(to)}) $search_fold$`;
}

const TERM = `substr(word.value, 1, ${SEARCH_TERM_MAX_LENGTH})`;
const INSERT = `INSERT INTO ${SEARCH_INDEX_TABLE} (source, doc_id, col, term, tf)`;
const words = (folded: string) => `json_each('[' || replace(json_quote(${folded}), ' ', '","') || ']') AS word`;

/**
 * SQLite: one term row per distinct term of column `index` of the row NEW,
 * or of every row of `source` (`all`), with its count. The split goes through JSON.
 */
function sqliteTermRows(source: SearchSource, index: number, all = false): string {
  const row = all ? "src" : "NEW";
  const folded = sqliteFoldSql(columnSql(source, index, row, "sqlite"));
  return `${INSERT} SELECT ${quote(source)}, ${row}.id, ${index}, ${TERM}, count(*) FROM ${all ? `${source} AS src, ` : ""}${words(folded)} WHERE word.value <> '' GROUP BY ${all ? "src.id, " : ""}${TERM}`;
}

/**
 * PostgreSQL: one statement that indexes the row NEW, or every row of
 * `source` (`all`): each column folded by the fold function and split with
 * string_to_array, then the term rows and the document row. It never reads
 * the index, so concurrent SERIALIZABLE writers take no predicate locks on it.
 */
function postgresIndexStatement(source: SearchSource, all = false): string {
  const row = all ? "src" : "NEW";
  const words = SEARCH_SOURCES[source].map((_, index) =>
    `SELECT ${row}.id AS doc_id, ${index} AS col, substr(value, 1, ${SEARCH_TERM_MAX_LENGTH}) AS term FROM ${all ? `${source} AS src, ` : ""}`
    + `unnest(string_to_array(scalius_compat.${SEARCH_FOLD_TABLE}(${columnSql(source, index, row, "postgres")}), ' ')) AS word(value) WHERE value <> ''`);
  const documents = all
    ? `SELECT ${quote(source)}, src.id, -1, '', coalesce(tokens.n, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id`
    : `SELECT ${quote(source)}, NEW.id, -1, '', count(*) FROM words`;
  return `WITH words AS (${words.join(" UNION ALL ")}) ${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL ${documents}`;
}

/** Index the row NEW of `source`: its terms, then its document row (its token count). */
function indexRowStatements(dialect: SearchIndexDialect, source: SearchSource): string[] {
  if (dialect === "postgres") return [postgresIndexStatement(source)];
  return [
    ...SEARCH_SOURCES[source].map((_, index) => sqliteTermRows(source, index)),
    `${INSERT} SELECT ${quote(source)}, NEW.id, -1, '', coalesce(sum(tf), 0) FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = NEW.id`,
  ];
}

const deleteRow = (source: SearchSource) =>
  `DELETE FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = OLD.id`;

export interface SearchIndexTrigger {
  name: string;
  /** A `CREATE TRIGGER` in SQLite form; with the postgres dialect its body is PostgreSQL SQL for the trigger compiler. */
  sql: string;
}

/**
 * The insert, update and delete triggers of every source. An insert compiles
 * only its own source's trigger (Turso compiles every nested trigger program
 * per statement, without SQLite's cache, so one shared trigger that indexes
 * every source would make each insert compile all of them).
 */
export function searchIndexTriggers(dialect: SearchIndexDialect): SearchIndexTrigger[] {
  return (Object.keys(SEARCH_SOURCES) as SearchSource[]).flatMap((source) => {
    const columns = ["id", ...SEARCH_SOURCES[source].map(([, column]) => column).filter((column) => column !== "id")];
    const body = (statements: string[]) => `BEGIN\n  ${statements.join(";\n  ")};\nEND`;
    const name = (event: string) => `${SEARCH_INDEX_TABLE}_${source}_${event}`;
    return [
      { name: name("insert"), sql: `CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${source}\n${body(indexRowStatements(dialect, source))}` },
      {
        name: name("update"),
        sql: `CREATE TRIGGER ${name("update")} AFTER UPDATE OF ${columns.join(", ")} ON ${source}\n`
          + `WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}\n`
          + body([deleteRow(source), ...indexRowStatements(dialect, source)]),
      },
      { name: name("delete"), sql: `CREATE TRIGGER ${name("delete")} AFTER DELETE ON ${source}\n${body([deleteRow(source)])}` },
    ];
  });
}

const SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];

/** SQLite: every source's term rows, then (`documents`) every source's document rows, read from the term rows. */
const sqliteRebuild = {
  terms: () => SOURCES.flatMap((source) => SEARCH_SOURCES[source].map((_, index) => sqliteTermRows(source, index, true))),
  documents: () => SOURCES.map((source) =>
    `${INSERT} SELECT ${quote(source)}, src.id, -1, '', coalesce(terms.tokens, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, sum(tf) AS tokens FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} GROUP BY doc_id) AS terms ON terms.doc_id = src.id`),
};

/** Rebuilds the whole index from its sources (the migration backfill, and after an import). */
export function searchIndexRebuildStatements(dialect: SearchIndexDialect): string[] {
  return [
    `DELETE FROM ${SEARCH_INDEX_TABLE}`,
    ...(dialect === "postgres" ? SOURCES.map((source) => postgresIndexStatement(source, true)) : [...sqliteRebuild.terms(), ...sqliteRebuild.documents()]),
  ];
}

/**
 * The table, then its two indexes (SQLite DDL; the PostgreSQL schema compiles
 * it). A backfill builds an index once, sorted, after its rows: far cheaper
 * than millions of inserts into it in term order.
 */
export const SEARCH_INDEX_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE ${SEARCH_INDEX_TABLE} (\n  source text NOT NULL,\n  doc_id text NOT NULL,\n  col integer NOT NULL,\n  term text NOT NULL,\n  tf integer NOT NULL\n)`,
  // Term lookups and prefix ranges read only this index (tf included for bm25).
  `CREATE INDEX ${SEARCH_INDEX_TABLE}_term_idx ON ${SEARCH_INDEX_TABLE} (source, term, col, doc_id, tf)`,
  // A row's terms: its deletes, its document row (term '', col -1) and its count sum, and bm25's per-row seeks.
  `CREATE INDEX ${SEARCH_INDEX_TABLE}_doc_idx ON ${SEARCH_INDEX_TABLE} (source, doc_id, term, col, tf)`,
];

/** Migration 0152 on Turso: the table, the fold table, its triggers, the term rows, the document index and rows, then the term index. */
export function searchIndexSqliteMigrationStatements(): string[] {
  const [table, termIndex, documentIndex] = SEARCH_INDEX_TABLE_STATEMENTS;
  return [
    table!,
    ...searchFoldTableStatements(),
    ...searchIndexTriggers("sqlite").map((trigger) => trigger.sql),
    ...sqliteRebuild.terms(),
    documentIndex!,
    ...sqliteRebuild.documents(),
    termIndex!,
  ];
}

/**
 * Migration 0220 on Turso: the fold table (full FTS5 fold, rich text read
 * without markup), every source's triggers again, and the index rebuilt as
 * 0152 built it (rows first, then each index once, sorted). External
 * providers upgrade under the verified write freeze, so the rebuild holds no
 * buyer's write.
 */
export function searchIndexSqliteRefreshStatements(): string[] {
  const [, termIndex, documentIndex] = SEARCH_INDEX_TABLE_STATEMENTS;
  const triggers = searchIndexTriggers("sqlite");
  return [
    ...searchFoldTableStatements(),
    ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${trigger.name}`),
    ...triggers.map((trigger) => trigger.sql),
    `DROP INDEX IF EXISTS ${SEARCH_INDEX_TABLE}_term_idx`,
    `DROP INDEX IF EXISTS ${SEARCH_INDEX_TABLE}_doc_idx`,
    `DELETE FROM ${SEARCH_INDEX_TABLE}`,
    ...sqliteRebuild.terms(),
    documentIndex!,
    ...sqliteRebuild.documents(),
    termIndex!,
  ];
}
