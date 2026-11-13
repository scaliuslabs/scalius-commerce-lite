/**
 * The text search index of the providers without FTS5 (Turso, PostgreSQL),
 * and the text every provider's search reads.
 *
 * D1 searches its FTS5 tables (`<source>_fts`, unicode61). Turso has no FTS5
 * and its own FTS index has no prefix queries, and PostgreSQL's parsers split
 * words differently, so both keep one table, `search_fts_terms`: one row per
 * distinct term of each indexed column of each row, with its count, and one
 * document row (`col` -1, `term` '') with the row's token count. Triggers
 * generated here maintain it from the same sources and columns as the FTS5
 * tables, with FTS5's tokens (the fold in `@scalius/shared/search-text`, which
 * the query side folds with too). A query reads a term prefix as an index
 * range, and ranks with FTS5's bm25 over the same counts (core `search/`).
 *
 * A rich-text column (a product's or category's description, a page's
 * content) is never parsed in SQL: the write that stores it also stores its
 * search text in a companion column (SEARCH_TEXT_COLUMNS), computed in
 * TypeScript (`richTextSearchText`: plain text, folded, bounded). Every
 * provider indexes the companion as it is (split on spaces, never folded
 * again); a row whose companion is still NULL (written before 0219, or by SQL
 * that bypassed the write path) is indexed from the first
 * SEARCH_TEXT_MAX_LENGTH characters of its raw column on every provider,
 * until the scheduled backfill fills it. Every other column is short and is
 * folded in SQL: its first SEARCH_PLAIN_MAX_LENGTH characters, on Turso one
 * fold-table lookup per character of each word that is not plain ASCII.
 *
 * Known differences from FTS5 (docs/DATABASE-PORTABILITY.md, Text search):
 * characters outside the Basic Multilingual Plane (emoji) stay inside a term,
 * a term holds at most 100 characters, and the terms of one query word that a
 * separator splits match in one column without their adjacency.
 *
 * The table names match `_fts`, so every tool that treats FTS5 tables as
 * derived (exports, imports, schema fingerprints) treats them the same way;
 * an import rebuilds the index with `searchIndexRebuildStatements`.
 *
 * Pure SQL text and string functions: no bindings or database access.
 */
import {
  SEARCH_FOLD_MAP,
  SEARCH_NORMALIZATION,
  SEARCH_TERM_MAX_LENGTH,
  SEARCH_TEXT_MAX_LENGTH,
} from "@scalius/shared/search-text";

export {
  SEARCH_FOLD_MAP,
  SEARCH_NORMALIZATION,
  SEARCH_TERM_MAX_LENGTH,
  SEARCH_TEXT_MAX_LENGTH,
  foldSearchText,
  richTextSearchText,
  searchTerms,
} from "@scalius/shared/search-text";

export const SEARCH_INDEX_TABLE = "search_fts_terms";

/**
 * Each FTS5 table's source and columns: `[fts5Column, sourceColumn]`. The
 * column position is the term's `col` and the bm25 weight index.
 * `fts5Column` is D1's FTS5 column name. Two differ from their source
 * column since 0000: pages_fts.content_col (pages.content) and
 * orders_fts.order_id (orders.id). Matching, inserts and FTS5 'delete' name
 * the FTS5 columns and work; anything that reads a column back through the
 * FTS5 table (a full count, snippet(), highlight(), 'rebuild', a rank-1
 * integrity check) fails on those two and is refused by a test. A schema
 * baseline squash is where their declaration gets corrected.
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
 * The newest rows of each D1 FTS5 table 0219 makes current itself; a table
 * with more rows leaves the older ones in the raw form (still found) for the
 * scheduled fill (`@scalius/core/search` reindexFts5Slice). A row whose form
 * changes costs about four rows written (its raw-form entries deleted, its
 * current-form entries written), so 0219 writes at most about 24,000 rows on
 * any store, under a quarter of Workers Free's daily writes: orders 8,000,
 * products 5,000, customers 4,000, categories and pages 2,000 each, reviews
 * and SKUs 1,000 each, menu items and abandoned checkouts 500 each.
 */
export const FTS5_MIGRATION_ROWS: Readonly<Record<SearchSource, number>> = {
  orders: 2_000,
  products: 1_250,
  customers: 1_000,
  categories: 500,
  pages: 500,
  product_reviews: 250,
  product_variants: 250,
  navigation_menu_items: 125,
  abandoned_checkouts: 125,
};

/** About the rows written per row whose form the migration or the fill changes (see FTS5_MIGRATION_ROWS). */
export const FTS5_FILL_ROW_COST = 4;

/** A D1 FTS5 table's column names, as its table declares them (`SEARCH_SOURCES`' first names). */
export function fts5ColumnNames(source: SearchSource): string[] {
  return SEARCH_SOURCES[source].map(([ftsColumn]) => ftsColumn);
}

/**
 * The `settings` key (category `maintenance`) of a table whose older rows
 * the fill has not reached: its value is the largest such rowid. Every row
 * above it is indexed in the current form; every row at or below it in the
 * raw form every trigger before 0219 wrote (still found).
 * No row means the table is current. The triggers read it to choose the
 * form, so a row's form always follows from its rowid and this value.
 */
export function fts5OldThroughKey(source: SearchSource): string {
  return `fts5-old-through:${source}`;
}

/** The key range the fill's cursors occupy (`key >= from AND key < to`). */
export const FTS5_OLD_THROUGH_KEYS = { from: "fts5-old-through:", to: "fts5-old-through;" } as const;

/** SQL: the table's old-through rowid, 0 when it is current (rowids start at 1). */
export function fts5OldThroughSql(source: SearchSource): string {
  return `COALESCE((SELECT CAST(\`value\` AS INTEGER) FROM \`settings\` WHERE \`category\` = 'maintenance' AND \`key\` = '${fts5OldThroughKey(source)}'), 0)`;
}

/** SQL: each column of row `row` as every trigger before 0219 indexed it, the raw value. */
export function fts5OldFormValuesSql(source: SearchSource, row: string): string[] {
  return SEARCH_SOURCES[source].map(([, column]) => `${row}.\`${column}\``);
}

/** SQL: each column of row `row` in the current form (`fts5ColumnValueSql`). */
export function fts5NewFormValuesSql(source: SearchSource, row: string): string[] {
  return SEARCH_SOURCES[source].map(([, column]) => fts5ColumnValueSql(source, column, row));
}

/** SQL: whether row `row` indexes something else in the current form than in the raw form. */
export function fts5FormsDifferSql(source: SearchSource, row: string): string {
  const raw = fts5OldFormValuesSql(source, row);
  const current = fts5NewFormValuesSql(source, row);
  return `(${raw.map((value, index) => `${value} IS NOT ${current[index]}`).join(" OR ")})`;
}

/**
 * The rich-text columns (written with the dashboard's rich-text editor) and
 * the companion column holding each one's search text (`richTextSearchText`).
 */
export const SEARCH_TEXT_COLUMNS: Readonly<Partial<Record<SearchSource, Readonly<Record<string, string>>>>> = {
  products: { description: "description_search_text" },
  categories: { description: "description_search_text" },
  pages: { content: "content_search_text" },
};

/**
 * Each table with a rich-text column: the column its writes move with the
 * search text (its revision; the stale triggers compare it), one per table.
 */
export const SEARCH_TEXT_REV_COLUMNS: Readonly<Partial<Record<SearchSource, string>>> = {
  products: "description_search_rev",
  categories: "description_search_rev",
  pages: "content_search_rev",
};

/** The characters of any other column the index reads: its first 2,000 (names, codes, a review's body). */
export const SEARCH_PLAIN_MAX_LENGTH = 2_000;

/** The characters of a rich-text column the index reads while its row has no search text: as many as a search text holds, on every provider. */
export const SEARCH_RAW_MAX_LENGTH = SEARCH_TEXT_MAX_LENGTH;

const companionOf = (source: SearchSource, column: string): string | undefined => SEARCH_TEXT_COLUMNS[source]?.[column];

/**
 * The text the index reads of rich-text column `column` of the row `row`
 * before any fold (`raw`: the raw column's bounded prefix as SQL): its search
 * text, or that prefix while it has none. Equal before and after a write
 * exactly when the indexed terms are, so the update triggers compare it.
 */
const richIndexedText = (row: string, column: string, companion: string, raw = (text: string) => text) =>
  `coalesce(${row}.${companion}, ${raw(`substr(${row}.${column}, 1, ${SEARCH_RAW_MAX_LENGTH})`)})`;

/** The source columns a source's triggers watch: each indexed column and its companion. */
export function searchWatchedColumns(source: SearchSource): string[] {
  return [...new Set(SEARCH_SOURCES[source].flatMap(([, column]) => [column, ...(companionOf(source, column) ? [companionOf(source, column)!] : [])]))];
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const printable = (character: string) => character >= " " && character <= "~";
// Characters outside printable ASCII are written as code points, never raw, in SQL text.
const sqliteCharacter = (character: string) => character === "" ? "''"
  : [...character].map((point) => printable(point) ? quote(point) : `char(${point.codePointAt(0)})`).join(" || ");
const postgresText = (text: string) => `E'${[...text].map((character) => character === "'" ? "''" : character === "\\" ? "\\\\" : printable(character) ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}'`;

export type SearchIndexDialect = "sqlite" | "postgres";

/**
 * Whether column `column` of `source` indexes something else after an
 * update (`OLD` against `NEW`): a rich-text column's indexed text
 * (`richIndexedText`), any other column's value. Every provider's update
 * triggers fire on it, so a write that leaves the indexed text as it was (a
 * formatting-only save that keeps its search text) re-indexes nothing.
 */
export function searchColumnChangedSql(source: SearchSource, column: string): string {
  const companion = companionOf(source, column);
  return companion
    ? `${richIndexedText("OLD", column, companion)} IS NOT ${richIndexedText("NEW", column, companion)}`
    : `OLD.${column} IS NOT NEW.${column}`;
}

/**
 * The value D1's FTS5 triggers hand FTS5 for column `column` of the row `row`
 * (`NEW`, `OLD` or a source alias): a rich-text column's search text, or the
 * first SEARCH_RAW_MAX_LENGTH characters of the raw column while it has none;
 * any other column's first SEARCH_PLAIN_MAX_LENGTH characters. Raw text has
 * SEARCH_NORMALIZATION applied (FTS5 folds the rest).
 */
export function fts5ColumnValueSql(source: SearchSource, column: string, row: string): string {
  const companion = companionOf(source, column);
  const normalized = (text: string) => [...SEARCH_NORMALIZATION].reduce(
    (sql, [from, to]) => `replace(${sql}, ${sqliteCharacter(from)}, ${sqliteCharacter(to)})`, text);
  if (companion) return richIndexedText(row, column, companion, normalized);
  return normalized(`substr(${row}.${column}, 1, ${SEARCH_PLAIN_MAX_LENGTH})`);
}

/** The table the fold reads: one row per character FTS5 changes or the index normalises (ASCII capitals excepted). */
export const SEARCH_FOLD_TABLE = "search_fts_fold";

/** The fold table, emptied and filled from SEARCH_FOLD_MAP (idempotent). */
export function searchFoldTableStatements(dialect: SearchIndexDialect = "sqlite"): string[] {
  const literal = (text: string) => dialect === "postgres" ? postgresText(text) : sqliteCharacter(text);
  const rows = [...SEARCH_FOLD_MAP].map(([from, to]) => `(${literal(from)}, ${literal(to)})`);
  const inserts: string[] = [];
  for (let index = 0; index < rows.length; index += 500) {
    inserts.push(`INSERT INTO ${SEARCH_FOLD_TABLE} (ch, folded) VALUES ${rows.slice(index, index + 500).join(", ")}`);
  }
  const collate = dialect === "postgres" ? ` COLLATE "C"` : "";
  return [
    `CREATE TABLE IF NOT EXISTS ${SEARCH_FOLD_TABLE} (\n  ch text${collate} PRIMARY KEY NOT NULL,\n  folded text NOT NULL\n)`,
    `DELETE FROM ${SEARCH_FOLD_TABLE}`,
    ...inserts,
  ];
}

/**
 * PostgreSQL: the fold of a short text (at most SEARCH_PLAIN_MAX_LENGTH
 * characters: the callers bound it): lower-cased (ASCII), split into
 * characters, each looked up in the fold table, joined in order.
 */
export function searchFoldPostgresFunction(): string {
  return `CREATE OR REPLACE FUNCTION scalius_compat.${SEARCH_FOLD_TABLE}(value text) RETURNS text\nLANGUAGE sql STABLE PARALLEL SAFE\n`
    + `AS $search_fold$ SELECT string_agg(coalesce(fold.folded, letter.ch), '' ORDER BY letter.n) FROM unnest(string_to_array(lower(value COLLATE "C"), NULL)) WITH ORDINALITY AS letter(ch, n) LEFT JOIN public.${SEARCH_FOLD_TABLE} AS fold ON fold.ch = letter.ch $search_fold$`;
}

/**
 * SQLite: the folded text of one space-separated word (`word.value`), each
 * character looked up in the fold table. The word is short (its column is
 * bounded), so the per-character reads stay small.
 */
const SQLITE_WORD_FOLD = (() => {
  const byte = "substr(text.bytes, position.key + 1, 1)";
  const length = `1 + (${byte} >= x'C0') + (${byte} >= x'E0') + (${byte} >= x'F0')`;
  const characters = `SELECT CAST(substr(text.bytes, position.key + 1, ${length}) AS TEXT) AS ch`
    // LIMIT 1 keeps the bytes one value; flattened, every character re-read the word.
    + ` FROM (SELECT CAST(word.value AS BLOB) AS bytes LIMIT 1) AS text,`
    + ` json_each('[' || replace(hex(zeroblob(length(text.bytes))), '00', '0,') || '0]') AS position`
    + ` WHERE ${byte} < x'80' OR ${byte} >= x'C0'`;
  return `(SELECT group_concat(coalesce((SELECT fold.folded FROM ${SEARCH_FOLD_TABLE} AS fold WHERE fold.ch = character.ch), character.ch), '') FROM (${characters}) AS character)`;
})();

const TERM = `substr(term.value, 1, ${SEARCH_TERM_MAX_LENGTH})`;
const INSERT = `INSERT INTO ${SEARCH_INDEX_TABLE} (source, doc_id, col, term, tf)`;
const words = (text: string, alias: string) => `json_each('[' || replace(json_quote(${text}), ' ', '","') || ']') AS ${alias}`;

/** Whether the generator writes companion columns (false: 0152's expansion, before 0219 added them). */
interface Stage { companions: boolean }
const CURRENT: Stage = { companions: true };

/**
 * SQLite: one term row per distinct term of column `index` of the row NEW,
 * or of every row of `source` (`all`), with its count. A companion's search
 * text is already folded: it is split on spaces and nothing else. Otherwise
 * (a short column, or a rich-text column whose row has no search text: the
 * raw column's first SEARCH_RAW_MAX_LENGTH characters) the text is
 * lower-cased and split, and a word that is not plain ASCII letters and
 * digits is folded. Each branch reads an empty text when the other applies,
 * so no engine folds a search text.
 */
function sqliteTermRows(source: SearchSource, index: number, all: boolean, stage: Stage): string {
  const row = all ? "src" : "NEW";
  const column = SEARCH_SOURCES[source][index]![1];
  const companion = stage.companions ? companionOf(source, column) : undefined;
  const from = all ? `${source} AS src, ` : "";
  const group = `GROUP BY ${all ? "src.id, " : ""}${TERM}`;
  const select = `SELECT ${quote(source)}, ${row}.id, ${index}, ${TERM}, count(*) FROM ${from}`;
  const raw = `lower(substr(${row}.${column}, 1, ${companion ? SEARCH_RAW_MAX_LENGTH : SEARCH_PLAIN_MAX_LENGTH}))`;
  const foldedTerms = (text: string) => `${select}${words(text, "word")}, `
    + `${words(`CASE WHEN word.value GLOB '*[^a-z0-9]*' THEN ${SQLITE_WORD_FOLD} ELSE word.value END`, "term")} WHERE term.value <> '' ${group}`;
  if (!companion) return `${INSERT} ${foldedTerms(raw)}`;
  return `${INSERT} ${select}${words(`coalesce(${row}.${companion}, '')`, "term")} WHERE term.value <> '' ${group}`
    + ` UNION ALL ${foldedTerms(`CASE WHEN ${row}.${companion} IS NULL THEN ${raw} ELSE '' END`)}`;
}

/** PostgreSQL: the words (doc_id, col, term) of column `index` of the row `row`. */
function postgresWords(source: SearchSource, index: number, row: string, all: boolean, stage: Stage): string {
  const column = SEARCH_SOURCES[source][index]![1];
  const companion = stage.companions ? companionOf(source, column) : undefined;
  const folded = `scalius_compat.${SEARCH_FOLD_TABLE}(substr(${row}.${column}, 1, ${companion ? SEARCH_RAW_MAX_LENGTH : SEARCH_PLAIN_MAX_LENGTH}))`;
  // coalesce reads its second argument only when the first is NULL: a search text is never folded again.
  const text = companion ? `coalesce(${row}.${companion}, ${folded})` : folded;
  return `SELECT ${row}.id AS doc_id, ${index} AS col, substr(value, 1, ${SEARCH_TERM_MAX_LENGTH}) AS term FROM ${all ? `${source} AS src, ` : ""}`
    + `unnest(string_to_array(${text}, ' ')) AS word(value) WHERE value <> ''`;
}

/**
 * PostgreSQL: one statement that indexes the row NEW, or every row of
 * `source` (`all`): each column's words, then the term rows and the document
 * row. It never reads the index, so concurrent SERIALIZABLE writers take no
 * predicate locks on it.
 */
function postgresIndexStatement(source: SearchSource, all: boolean, stage: Stage, columns = SEARCH_SOURCES[source].map((_, index) => index)): string {
  const row = all ? "src" : "NEW";
  const parts = columns.map((index) => postgresWords(source, index, row, all, stage));
  const documents = all
    ? `SELECT ${quote(source)}, src.id, -1, '', coalesce(tokens.n, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id`
    : `SELECT ${quote(source)}, NEW.id, -1, '', count(*) FROM words`;
  return `WITH words AS (${parts.join(" UNION ALL ")}) ${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL ${documents}`;
}

/**
 * PostgreSQL: re-index column `index` of the row NEW alone: its old terms
 * deleted, its new ones written, and the document row's token count moved
 * by the difference (data-modifying CTEs: the index is read only through
 * the rows the statement deletes).
 */
function postgresColumnStatement(source: SearchSource, index: number): string {
  return `WITH gone AS (DELETE FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = OLD.id AND col = ${index} RETURNING tf), `
    + `words AS (${postgresWords(source, index, "NEW", false, CURRENT)}), `
    + `added AS (${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) `
    + `UPDATE ${SEARCH_INDEX_TABLE} SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) `
    + `WHERE source = ${quote(source)} AND doc_id = NEW.id AND col = -1 AND term = ''`;
}

const documentRow = (source: SearchSource) =>
  `${INSERT} SELECT ${quote(source)}, NEW.id, -1, '', coalesce(sum(tf), 0) FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = NEW.id AND col >= 0`;

/** Index the row NEW of `source`: its terms, then its document row (its token count). */
function indexRowStatements(dialect: SearchIndexDialect, source: SearchSource, stage: Stage): string[] {
  if (dialect === "postgres") return [postgresIndexStatement(source, false, stage)];
  return [...SEARCH_SOURCES[source].map((_, index) => sqliteTermRows(source, index, false, stage)), documentRow(source)];
}

/** Re-index column `index` of the row NEW of `source` alone, and its document row. */
function indexColumnStatements(dialect: SearchIndexDialect, source: SearchSource, index: number): string[] {
  if (dialect === "postgres") return [postgresColumnStatement(source, index)];
  return [
    `DELETE FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = OLD.id AND (col = ${index} OR col = -1)`,
    sqliteTermRows(source, index, false, CURRENT),
    documentRow(source),
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
 * The triggers of every source: insert, delete, a change of the row id
 * (every column again), and one per indexed column, `UPDATE OF` that column
 * and its companion, re-indexing that column alone: a name edit never reads
 * a description, and a price, stock or status write neither fires nor
 * compiles any of them. An insert compiles only its own source's trigger
 * (Turso compiles every nested trigger program per statement, without
 * SQLite's cache). `stage`: 0152's expansion writes no companion.
 */
export function searchIndexTriggers(dialect: SearchIndexDialect, stage: Stage = CURRENT): SearchIndexTrigger[] {
  return (Object.keys(SEARCH_SOURCES) as SearchSource[]).flatMap((source) => {
    const body = (statements: string[]) => `BEGIN\n  ${statements.join(";\n  ")};\nEND`;
    const name = (event: string) => `${SEARCH_INDEX_TABLE}_${source}_${event}`;
    const columns = SEARCH_SOURCES[source].map(([, column], index) => ({ column, index })).filter(({ column }) => column !== "id");
    return [
      { name: name("insert"), sql: `CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${source}\n${body(indexRowStatements(dialect, source, stage))}` },
      {
        name: name("update"),
        sql: `CREATE TRIGGER ${name("update")} AFTER UPDATE OF id ON ${source}\nWHEN OLD.id IS NOT NEW.id\n`
          + body([deleteRow(source), ...indexRowStatements(dialect, source, stage)]),
      },
      ...columns.map(({ column, index }) => {
        const companion = stage.companions ? companionOf(source, column) : undefined;
        const watched = [column, ...(companion ? [companion] : [])];
        // A rich-text column: re-indexed when the text it indexes changed (a formatting-only save that
        // keeps its search text, or the stale trigger's outer write, re-indexes nothing).
        const changed = companion ? searchColumnChangedSql(source, column) : `OLD.${column} IS NOT NEW.${column}`;
        return {
          name: name(`update_${index}`),
          sql: `CREATE TRIGGER ${name(`update_${index}`)} AFTER UPDATE OF ${watched.join(", ")} ON ${source}\n`
            + `WHEN ${changed} AND OLD.id IS NEW.id\n`
            + body(stage.companions ? indexColumnStatements(dialect, source, index) : [deleteRow(source), ...indexRowStatements(dialect, source, stage)]),
        };
      }),
      { name: name("delete"), sql: `CREATE TRIGGER ${name("delete")} AFTER DELETE ON ${source}\n${body([deleteRow(source)])}` },
    ];
  });
}

/**
 * The triggers that keep a companion honest when SQL outside the write path
 * changes a rich-text column. Every write path stores the search text with
 * the column and moves the row's search revision (SEARCH_TEXT_REV_COLUMNS) in
 * the same statement; a change of the column that leaves the revision as it
 * was came from elsewhere, so its search text (or its mark as needing none)
 * is cleared: the row is indexed from the raw column (the clear is a second
 * write, and the index triggers compare the indexed text, so the outer write
 * re-indexes nothing whatever order the triggers fire in) and the scheduled
 * backfill fills it again. A write path that stores the same search text (a
 * formatting-only edit) moved the revision: nothing is cleared or re-indexed.
 * Every provider (canonical SQLite; the PostgreSQL compiler).
 */
export function searchTextStaleTriggers(): SearchIndexTrigger[] {
  return Object.entries(SEARCH_TEXT_COLUMNS).flatMap(([source, companions]) =>
    Object.entries(companions!).map(([column, companion]) => {
      const name = `${source}_${companion}_stale`;
      const rev = SEARCH_TEXT_REV_COLUMNS[source as SearchSource]!;
      return {
        name,
        sql: [
          `CREATE TRIGGER \`${name}\``,
          `AFTER UPDATE OF \`${column}\` ON \`${source}\``,
          `WHEN OLD.\`${column}\` IS NOT NEW.\`${column}\` AND NEW.\`${rev}\` IS OLD.\`${rev}\` AND (NEW.\`${companion}\` IS NOT NULL OR NEW.\`${rev}\` < 0)`,
          "BEGIN",
          `  UPDATE \`${source}\` SET \`${companion}\` = NULL, \`${rev}\` = 0 WHERE \`id\` = NEW.\`id\`;`,
          "END",
        ].join("\n"),
      };
    }));
}

const SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];

/** SQLite: every source's term rows (of the columns `columns` keeps), then every source's document rows, read from the term rows. */
const sqliteRebuild = {
  terms: (stage: Stage, columns: (source: SearchSource, index: number) => boolean = () => true) =>
    SOURCES.flatMap((source) => SEARCH_SOURCES[source].map((_, index) => index).filter((index) => columns(source, index)).map((index) => sqliteTermRows(source, index, true, stage))),
  documents: () => SOURCES.map((source) =>
    `${INSERT} SELECT ${quote(source)}, src.id, -1, '', coalesce(terms.tokens, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, sum(tf) AS tokens FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND col >= 0 GROUP BY doc_id) AS terms ON terms.doc_id = src.id`),
};

/** Rebuilds the whole index from its sources (after an import into a current schema). */
export function searchIndexRebuildStatements(dialect: SearchIndexDialect): string[] {
  return [
    `DELETE FROM ${SEARCH_INDEX_TABLE}`,
    ...(dialect === "postgres" ? SOURCES.map((source) => postgresIndexStatement(source, true, CURRENT)) : [...sqliteRebuild.terms(CURRENT), ...sqliteRebuild.documents()]),
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

/** Migration 0152 on Turso: the table, the fold table, its triggers (no companions yet), the term rows, the document index and rows, then the term index. */
export function searchIndexSqliteMigrationStatements(): string[] {
  const [table, termIndex, documentIndex] = SEARCH_INDEX_TABLE_STATEMENTS;
  const legacy: Stage = { companions: false };
  return [
    table!,
    ...searchFoldTableStatements(),
    ...searchIndexTriggers("sqlite", legacy).map((trigger) => trigger.sql),
    ...sqliteRebuild.terms(legacy),
    documentIndex!,
    ...sqliteRebuild.documents(),
    termIndex!,
  ];
}

/** Whether column `index` of `source` is a rich-text column (indexed from its companion). */
const isRichText = (source: SearchSource, index: number) => Boolean(companionOf(source, SEARCH_SOURCES[source][index]![1]));

/**
 * Migration 0219 on Turso: the fold table, every source's triggers again, and
 * the terms of every column except the rich-text ones written again (bounded
 * short columns), then every document row. A rich-text column keeps the terms
 * it has: its companion is still NULL, and the backfill re-indexes each row
 * as it fills it. External providers upgrade under the verified write freeze.
 */
export function searchIndexSqliteRefreshStatements(): string[] {
  const triggers = searchIndexTriggers("sqlite");
  const plain = (source: SearchSource, index: number) => !isRichText(source, index);
  const richColumns = SOURCES.flatMap((source) => SEARCH_SOURCES[source].map((_, index) => index).filter((index) => isRichText(source, index)).map((index) => `(source = ${quote(source)} AND col = ${index})`));
  return [
    ...searchFoldTableStatements(),
    ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${trigger.name}`),
    ...triggers.map((trigger) => trigger.sql),
    `DELETE FROM ${SEARCH_INDEX_TABLE} WHERE NOT (${richColumns.join(" OR ")})`,
    ...sqliteRebuild.terms(CURRENT, plain),
    ...sqliteRebuild.documents(),
  ];
}

/** PostgreSQL: the same refresh (the fold table and function come with the schema). */
export function searchIndexPostgresRefreshStatements(): string[] {
  const richColumns = SOURCES.flatMap((source) => SEARCH_SOURCES[source].map((_, index) => index).filter((index) => isRichText(source, index)).map((index) => `(source = ${quote(source)} AND col = ${index})`));
  return [
    `DELETE FROM ${SEARCH_INDEX_TABLE} WHERE NOT (${richColumns.join(" OR ")})`,
    ...SOURCES.flatMap((source) => {
      const plain = SEARCH_SOURCES[source].map((_, index) => index).filter((index) => !isRichText(source, index));
      const keep = SEARCH_SOURCES[source].map((_, index) => index).filter((index) => isRichText(source, index));
      // Plain columns' terms, and each document row counted from every column's terms (rich ones kept).
      const terms = `WITH words AS (${plain.map((index) => postgresWords(source, index, "src", true, CURRENT)).join(" UNION ALL ")}) ${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term`;
      const documents = `${INSERT} SELECT ${quote(source)}, src.id, -1, '', coalesce(tokens.n, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, sum(tf) AS n FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND col >= 0 GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id`;
      return keep.length === SEARCH_SOURCES[source].length ? [documents] : [terms, documents];
    }),
  ];
}
