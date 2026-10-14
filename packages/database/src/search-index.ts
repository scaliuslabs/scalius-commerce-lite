/**
 * The text search index of the providers without FTS5 (Turso, PostgreSQL).
 *
 * D1 searches its FTS5 tables (`<source>_fts`, unicode61). Turso has no FTS5
 * and its own FTS index has no prefix queries, and PostgreSQL's parsers split
 * words differently, so both keep one table, `search_fts_terms`: one row per
 * distinct term of each indexed column of each row, with its count, and one
 * document row (`col` -1, `term` '') with the row's token count. Triggers
 * generated here maintain it from the same sources and columns as the FTS5
 * tables, with FTS5's tokens: lower-case, the Latin-1 letters folded as
 * `remove_diacritics 2` folds them, and every ASCII punctuation character and
 * the listed Unicode spaces, punctuation and joiners splitting words. A query
 * reads a term prefix as an index range, and ranks with FTS5's bm25 over the
 * same counts (core `search/`).
 *
 * Known differences from FTS5 (docs/DATABASE-PORTABILITY.md, Text search):
 * case and accents of letters outside ASCII and Latin-1 are kept, other
 * Unicode punctuation and symbols stay inside a term, a term holds at most
 * 100 characters, and the terms of one query word that a separator splits
 * match in one column without their adjacency.
 *
 * The table name matches `_fts`, so every tool that treats FTS5 tables as
 * derived (exports, imports, schema fingerprints) treats it the same way; an
 * import rebuilds it with `searchIndexRebuildStatements`.
 *
 * Pure SQL text and string functions: no bindings or database access.
 */

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

/** FTS5 (unicode61, remove_diacritics 2) folds these Latin-1 letters to these. */
const FOLD_FROM = "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞàáâãäåçèéêëìíîïñòóôõöùúûüýÿ";
const FOLD_TO = "aaaaaaæceeeeiiiiðnoooooøuuuuyþaaaaaaceeeeiiiinooooouuuuyy";

/** Characters FTS5 reads as word separators (besides the space). */
const ASCII_SEPARATORS = "\t\n\u000b\f\r!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const UNICODE_SEPARATORS = " ¡¢£¤¥¦§¨©«¬­®¯°±´¶·¸»¿×÷"
  + "           ​‌‍‎‏"
  + "‐‑‒–—―‖‗‘’‚‛“”„‟"
  + "†‡•‣․‥…‧  ‪‫‬‭‮ "
  + "‰‱′″‴‵‶‷‸‹› ⁠⁡⁢⁣⁤"
  + "€₹™　、。﻿।॥৲৳৺৻";

/** Every mapped character and its replacement: one character each, never mapped again. */
export const SEARCH_FOLD_MAP: ReadonlyMap<string, string> = new Map([
  ...[...ASCII_SEPARATORS, ...UNICODE_SEPARATORS].map((character) => [character, " "] as const),
  ...[...FOLD_FROM].map((character, index) => [character, [...FOLD_TO][index]!] as const),
]);

/** The text as the index stores it, before it is split on spaces (ASCII lower-case, as SQL `lower()`). */
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
const sqliteCharacter = (character: string) => printable(character) ? quote(character) : `char(${character.codePointAt(0)})`;
const postgresText = (text: string) => `E'${[...text].map((character) => character === "'" ? "''" : character === "\\" ? "\\\\" : printable(character) ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}'`;

// SQLite has no translate(): the fold is a replace() chain. Turso parses an
// expression at most 100 levels deep and compiles a deep chain in time that
// grows faster than its length, so the chain runs in stages of 20, each a
// derived table. Each stage reads the previous one's `t` once: SQLite
// flattens the stages into one expression, which a second reference per
// stage would grow exponentially.
const STAGE_SIZE = 20;
const FOLD_PAIRS = [...SEARCH_FOLD_MAP];

function replaceChain(expression: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.reduce((sql, [from, to]) => `replace(${sql}, ${sqliteCharacter(from)}, ${sqliteCharacter(to)})`, expression);
}

/**
 * SQLite: a derived table of `id` and `t`, the folded `column` of the row NEW
 * (`source` undefined) or of every row of `source`.
 */
function sqliteFoldedTable(column: string, source?: SearchSource): string {
  const row = source ? "src" : "NEW";
  let table = `(SELECT ${row}.id AS id, lower(${row}.${column}) AS t${source ? ` FROM ${source} AS src` : ""})`;
  for (let index = 0; index < FOLD_PAIRS.length; index += STAGE_SIZE) {
    table = `(SELECT s.id AS id, ${replaceChain("s.t", FOLD_PAIRS.slice(index, index + STAGE_SIZE))} AS t FROM ${table} AS s)`;
  }
  return table;
}

export type SearchIndexDialect = "sqlite" | "postgres";

const TERM = `substr(value, 1, ${SEARCH_TERM_MAX_LENGTH})`;
const INSERT = `INSERT INTO ${SEARCH_INDEX_TABLE} (source, doc_id, col, term, tf)`;

/**
 * SQLite: one term row per distinct term of column `index` of the row NEW,
 * or of every row of `source` (`all`), with its count. The fold is the staged
 * replace() chain; the split goes through JSON.
 */
function sqliteTermRows(source: SearchSource, index: number, all = false): string {
  const column = SEARCH_SOURCES[source][index]![1];
  return `${INSERT} SELECT ${quote(source)}, folded.id, ${index}, ${TERM}, count(*) FROM ${sqliteFoldedTable(column, all ? source : undefined)} AS folded, json_each('[' || replace(json_quote(folded.t), ' ', '","') || ']') WHERE value <> '' GROUP BY ${all ? "folded.id, " : ""}${TERM}`;
}

/**
 * PostgreSQL: one statement that indexes the row NEW, or every row of
 * `source` (`all`): each column folded in one translate() pass and split with
 * string_to_array, then the term rows and the document row. It never reads
 * the index, so concurrent SERIALIZABLE writers take no predicate locks on it.
 */
function postgresIndexStatement(source: SearchSource, all = false): string {
  const row = all ? "src" : "NEW";
  const from = [...SEARCH_FOLD_MAP.keys()].join("");
  const to = [...SEARCH_FOLD_MAP.values()].join("");
  const words = SEARCH_SOURCES[source].map(([, column], index) =>
    `SELECT ${row}.id AS doc_id, ${index} AS col, ${TERM} AS term FROM ${all ? `${source} AS src, ` : ""}`
    + `unnest(string_to_array(translate(lower(${row}.${column} COLLATE "C"), ${postgresText(from)}, ${postgresText(to)}), ' ')) AS word(value) WHERE value <> ''`);
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

/** Migration 0152 on Turso: the table, its triggers, the term rows, the document index and rows, then the term index. */
export function searchIndexSqliteMigrationStatements(): string[] {
  const [table, termIndex, documentIndex] = SEARCH_INDEX_TABLE_STATEMENTS;
  return [
    table!,
    ...searchIndexTriggers("sqlite").map((trigger) => trigger.sql),
    ...sqliteRebuild.terms(),
    documentIndex!,
    ...sqliteRebuild.documents(),
    termIndex!,
  ];
}
