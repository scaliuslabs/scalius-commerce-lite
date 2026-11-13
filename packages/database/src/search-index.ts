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
 * The columns that hold rich text (HTML, written with the dashboard's
 * rich-text editor): the index reads their text, not their markup, on every
 * provider (`searchColumnTextSql`).
 */
export const SEARCH_HTML_COLUMNS: Readonly<Partial<Record<SearchSource, readonly string[]>>> = {
  products: ["description"],
  categories: ["description"],
  pages: ["content"],
};

const isHtmlColumn = (source: SearchSource, column: string) => SEARCH_HTML_COLUMNS[source]?.includes(column) ?? false;

/**
 * The characters the index reads from each column: the first 10,000 of its
 * text (after markup is removed). A search index needs a document's opening,
 * not the tail of a 200 KB description, and the bound caps what one product
 * or page save costs a store's only writer on every engine.
 */
export const SEARCH_TEXT_MAX_LENGTH = 10_000;

/**
 * The characters of a rich-text column the markup is removed from: its first
 * 20,000, which hold its first 10,000 characters of text unless markup is
 * more than half of it. Removing markup reads every character once, so this
 * caps that cost too.
 */
export const SEARCH_MARKUP_MAX_LENGTH = 20_000;

/**
 * Characters read differently before matching, on every provider and in
 * every query: the zero-width joiner and non-joiner are ignored (a word typed
 * with or without them matches), and the precomposed Bengali nukta letters
 * read as their canonical decomposition (Unicode composition exclusions,
 * which a query's NFC normalisation decomposes).
 */
export const SEARCH_NORMALIZATION: ReadonlyMap<string, string> = new Map([
  ["‌", ""],
  ["‍", ""],
  ["ড়", "ড়"],
  ["ঢ়", "ঢ়"],
  ["য়", "য়"],
]);

/**
 * Every character FTS5 changes and what it becomes: a separator a space, a
 * combining diacritic nothing, a letter its folded letter (search-fold-data.ts,
 * read from FTS5), then SEARCH_NORMALIZATION. ASCII capitals are left to `lower()`.
 */
export const SEARCH_FOLD_MAP: ReadonlyMap<string, string> = new Map([
  ...FTS5_SEPARATOR_RANGES.flatMap(([from, to]) => codePoints(from, to).filter((point) => point !== 0x20).map((point) => [String.fromCodePoint(point), " "] as const)),
  ...FTS5_DROPPED_RANGES.flatMap(([from, to]) => codePoints(from, to).map((point) => [String.fromCodePoint(point), ""] as const)),
  ...pairsOf(FTS5_FOLD_PAIRS),
  ...SEARCH_NORMALIZATION,
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
const sqliteCharacter = (character: string) => character === "" ? "''"
  : [...character].map((point) => printable(point) ? quote(point) : `char(${point.codePointAt(0)})`).join(" || ");
const postgresText = (text: string) => `E'${[...text].map((character) => character === "'" ? "''" : character === "\\" ? "\\\\" : printable(character) ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")}'`;

export type SearchIndexDialect = "sqlite" | "postgres";

/**
 * The SQL each dialect writes a piece of the text pipeline in. SQLite splits
 * through JSON (no regular expressions, no table functions over strings);
 * PostgreSQL through string_to_array. Choices are arithmetic on 0/1 flags
 * (`pick`), never CASE: remote D1 refuses some CASE forms in a trigger body,
 * and one form for both dialects keeps their results equal.
 */
interface TextSql {
  /** Rows `alias.value` and `alias.k` (0-based, in order) of `text` split on `delimiter`; one NULL row for NULL on SQLite, none on PostgreSQL. */
  split(text: string, delimiter: string, alias: string): string;
  join(value: string, separator: string, alias: string): string;
  position(text: string, needle: string): string;
  flag(condition: string): string;
  character(code: string): string;
  digits(text: string): string;
  hexDigits(text: string): string;
  /** The last six characters of `text`. */
  lastSix(text: string): string;
  /** `;` as SQL: a D1 trigger body keeps none inside a literal. */
  semicolon: string;
}

const TEXT_SQL: Record<SearchIndexDialect, TextSql> = {
  sqlite: {
    split: (text, delimiter, alias) => `json_each('[' || replace(json_quote(${text}), ${delimiter}, '","') || ']') AS ${alias}`,
    join: (value, separator) => `group_concat(${value}, ${separator})`,
    position: (text, needle) => `instr(${text}, ${needle})`,
    flag: (condition) => `(${condition})`,
    character: (code) => `char(${code})`,
    digits: (text) => `(${text} <> '' AND ${text} NOT GLOB '*[^0-9]*')`,
    hexDigits: (text) => `(${text} <> '' AND ${text} NOT GLOB '*[^0-9a-f]*')`,
    lastSix: (text) => `substr(${text}, -6)`,
    semicolon: "char(59)",
  },
  postgres: {
    split: (text, delimiter, alias) => `unnest(string_to_array(${text}, ${delimiter})) WITH ORDINALITY AS ${alias}(value, n)`,
    join: (value, separator, alias) => `string_agg(${value}, ${separator} ORDER BY ${alias}.n)`,
    position: (text, needle) => `strpos(${text}, ${needle})`,
    flag: (condition) => `CAST((${condition}) AS integer)`,
    character: (code) => `chr(${code})`,
    digits: (text) => `(${text} <> '' AND ${text} !~ '[^0-9]')`,
    hexDigits: (text) => `(${text} <> '' AND ${text} !~ '[^0-9a-f]')`,
    lastSix: (text) => `right(${text}, 6)`,
    semicolon: "';'",
  },
};

const key = (dialect: SearchIndexDialect, alias: string) => dialect === "sqlite" ? `${alias}.key` : `(${alias}.n - 1)`;
/** `value` when `condition` holds, else '' (SQL substr of length 0). */
const pick = (sql: TextSql, value: string, condition: string) => `substr(${value}, 1, ${sql.flag(condition)} * 1000000000)`;

/**
 * Named entities read as a space (punctuation and spaces, which split words
 * anyway); `zwj` and `zwnj` read as nothing (SEARCH_NORMALIZATION).
 */
const SEPARATOR_ENTITIES = ["nbsp", "amp", "lt", "gt", "quot", "apos", "copy", "reg", "trade", "hellip", "mdash", "ndash", "lsquo", "rsquo", "sbquo", "ldquo", "rdquo", "bdquo", "bull", "middot", "laquo", "raquo", "times", "divide", "deg", "euro", "pound", "yen", "cent", "sect", "para", "shy", "ensp", "emsp", "thinsp", "iexcl", "iquest"];
const ACCENT_ENTITIES = ["acute", "grave", "circ", "uml", "tilde", "ring", "cedil"];

/**
 * The text of a rich-text (HTML) expression, as the index reads it. The text
 * is split on `<`: a piece that starts with a letter, `/`, `!` or `?` is a
 * tag and keeps what follows its end (its first `>`, or its first `">` when
 * a quoted attribute opens before that `>`), a comment keeps what follows `-->`, a `<script>` or `<style>`
 * tag keeps nothing, and any other `<` is text. The pieces join with spaces.
 * Then it is split on `&`: a numeric entity reads as its character (a space
 * when the number names none), a Latin
 * letter entity (`&eacute;`) as its letter, a punctuation entity as a space,
 * and anything else as text. Linear in the text on every engine: each piece
 * is read once. A tag inside a word splits it; script text after a `<` in it
 * and comments that hold a `<` stay.
 */
function htmlTextSql(expression: string, dialect: SearchIndexDialect): string {
  const sql = TEXT_SQL[dialect];
  const v = "piece.value";
  const k = key(dialect, "piece");
  const first = `substr(${v}, 1, 1)`;
  const isTag = `${k} > 0 AND (lower(${first}) BETWEEN 'a' AND 'z' OR ${first} IN ('/', '!', '?'))`;
  const isComment = `${k} > 0 AND substr(${v}, 1, 3) = '!--'`;
  const end1 = sql.position(v, "'>'");
  // A `"` before the first `>` starts an attribute, which may hold a `>`: the tag then ends at its first `">`.
  const quote1 = sql.position(v, "'\"'");
  const quoteEnd = sql.position(v, "'\">'");
  const end = `(${end1} + ${sql.flag(`${quote1} > 0 AND ${quote1} < ${end1} AND ${quoteEnd} > 0`)} * (${quoteEnd} + 1 - ${end1}))`;
  const raw = `(lower(substr(${v}, 1, 6)) = 'script' OR lower(substr(${v}, 1, 5)) = 'style')`;
  const commentEnd = sql.position(v, "'-->'");
  const pieceText = [
    pick(sql, v, `${k} = 0`),
    pick(sql, `' ' || ${v}`, `${k} > 0 AND NOT (${isTag})`),
    pick(sql, `substr(${v}, ${commentEnd} + 3)`, `${isComment} AND ${commentEnd} > 0`),
    pick(sql, `substr(${v}, ${end} + 1)`, `${isTag} AND NOT (${isComment}) AND ${end1} > 0 AND NOT ${raw}`),
  ].join(" || ");
  const stripped = `(SELECT ${sql.join(pieceText, "' '", "piece")} FROM ${sql.split(expression, "'<'", "piece")})`;

  const e = "entity.value";
  const ek = key(dialect, "entity");
  const stop = sql.position(e, sql.semicolon);
  // The entity's name is the text before its `;`; each part is read from the piece directly (shallow SQL:
  // a fixed-depth parser such as libSQL's refuses deep nesting).
  const nameFrom = (start: number) => `substr(${e}, ${start}, ${stop} - ${start})`;
  const name = nameFrom(1);
  const nameLength = `(${stop} - 1)`;
  const rest = `substr(${e}, ${stop} + 1)`;
  const named = `${ek} > 0 AND ${stop} BETWEEN 2 AND 12`;
  // `&#2453;` and `&#x995;`: the character, or a space for a number that names none.
  const decimalDigits = nameFrom(2);
  const hexDigits = `lower(${nameFrom(3)})`;
  const isDecimal = `${named} AND substr(${e}, 1, 1) = '#' AND ${nameLength} BETWEEN 2 AND 11 AND ${sql.digits(decimalDigits)}`;
  const isHex = `${named} AND lower(substr(${e}, 1, 2)) = '#x' AND ${nameLength} BETWEEN 3 AND 8 AND ${sql.hexDigits(hexDigits)}`;
  // Six hex digits, right-aligned: digit i of `000000<digits>`, one term each (no nesting).
  const hexDigit = (position: number) => `(${sql.position("'0123456789abcdef'", `substr(${sql.lastSix(`'000000' || ${hexDigits}`)}, ${position}, 1)`)} - 1)`;
  const hexCode = [1, 2, 3, 4, 5, 6].map((position) => `${hexDigit(position)} * ${16 ** (6 - position)}`).join(" + ");
  const validCode = (codeSql: string) => `${codeSql} BETWEEN 1 AND 1114111 AND ${codeSql} NOT BETWEEN 55296 AND 57343`;
  const isNumeric = `((${isDecimal}) OR (${isHex}))`;
  // SQLite casts any text to a number (0 when it is none); PostgreSQL casts and chr() only on a valid
  // number (int4: the trigger compiler widens `integer` to bigint, and chr() takes int4).
  const code = dialect === "sqlite"
    ? `(${sql.flag(isDecimal)} * CAST(${decimalDigits} AS INTEGER) + ${sql.flag(isHex)} * (${hexCode}))`
    : `(CASE WHEN ${isDecimal} THEN CAST(${decimalDigits} AS bigint) WHEN ${isHex} THEN ${hexCode} ELSE 0 END)`;
  const decimal = dialect === "sqlite"
    ? `${pick(sql, `${sql.character(code)} || ${rest}`, `${isNumeric} AND ${validCode(code)}`)} || ${pick(sql, `' ' || ${rest}`, `${isNumeric} AND NOT (${validCode(code)})`)}`
    : `(CASE WHEN ${isNumeric} AND ${validCode(code)} THEN chr(CAST(${code} AS int4)) || ${rest} WHEN ${isNumeric} THEN ' ' || ${rest} ELSE '' END)`;
  const accent = `${named} AND ${nameLength} BETWEEN 4 AND 7 AND lower(substr(${e}, 1, 1)) BETWEEN 'a' AND 'z' AND ${nameFrom(2)} IN (${ACCENT_ENTITIES.map(quote).join(", ")})`;
  const separator = `${named} AND ${name} IN (${SEPARATOR_ENTITIES.map(quote).join(", ")})`;
  const joiner = `${named} AND ${name} IN ('zwj', 'zwnj')`;
  const entityText = [
    pick(sql, e, `${ek} = 0`),
    decimal,
    pick(sql, `substr(${e}, 1, 1) || ${rest}`, accent),
    pick(sql, `' ' || ${rest}`, separator),
    pick(sql, rest, joiner),
    pick(sql, `' ' || ${e}`, `${ek} > 0 AND NOT (${isNumeric} OR (${accent}) OR (${separator}) OR (${joiner}))`),
  ].join(" || ");
  return `(SELECT ${sql.join(entityText, "''", "entity")} FROM ${sql.split(stripped, "'&'", "entity")})`;
}

/**
 * The text the index reads from column `column` of `source` on the row `row`
 * (`NEW`, `OLD` or a source alias): a rich-text column's text without
 * markup, its first SEARCH_TEXT_MAX_LENGTH characters. `normalize` applies
 * SEARCH_NORMALIZATION in SQL, for D1's FTS5 tables (the search index folds
 * through SEARCH_FOLD_MAP, which holds it).
 */
export function searchColumnTextSql(source: SearchSource, column: string, row: string, dialect: SearchIndexDialect, { normalize = false } = {}): string {
  const value = `${row}.${column}`;
  const text = isHtmlColumn(source, column)
    ? `substr(${htmlTextSql(`substr(${value}, 1, ${SEARCH_MARKUP_MAX_LENGTH})`, dialect)}, 1, ${SEARCH_TEXT_MAX_LENGTH})`
    : `substr(${value}, 1, ${SEARCH_TEXT_MAX_LENGTH})`;
  return normalize
    ? [...SEARCH_NORMALIZATION].reduce((sql, [from, to]) => `replace(${sql}, ${sqliteCharacter(from)}, ${sqliteCharacter(to)})`, text)
    : text;
}

/** Tests: the text a rich-text value reads as, in one dialect (no bound). */
export function searchHtmlTextSql(expression: string, dialect: SearchIndexDialect): string {
  return htmlTextSql(expression, dialect);
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
 * PostgreSQL: the fold as one function: the text lower-cased (ASCII), split
 * into characters, each looked up in the fold table, joined in order. One
 * index probe per character, where a translate() of the whole map scanned
 * its 5,500 characters for every character of the text.
 */
export function searchFoldPostgresFunction(): string {
  return `CREATE OR REPLACE FUNCTION scalius_compat.${SEARCH_FOLD_TABLE}(value text) RETURNS text\nLANGUAGE sql STABLE PARALLEL SAFE\n`
    + `AS $search_fold$ SELECT string_agg(coalesce(fold.folded, letter.ch), '' ORDER BY letter.n) FROM unnest(string_to_array(lower(value COLLATE "C"), NULL)) WITH ORDINALITY AS letter(ch, n) LEFT JOIN public.${SEARCH_FOLD_TABLE} AS fold ON fold.ch = letter.ch $search_fold$`;
}

/**
 * SQLite: the folded text of one space-separated word (`word.value`). A word
 * of ASCII letters and digits only is already folded (`lower()` ran on the
 * whole text); any other word is read as UTF-8 bytes, each character looked
 * up in the fold table. Words are short, so the per-character reads stay
 * small; the whole text is read once.
 */
function sqliteWordFoldSql(): string {
  const byte = "substr(text.bytes, position.key + 1, 1)";
  const length = `1 + (${byte} >= x'C0') + (${byte} >= x'E0') + (${byte} >= x'F0')`;
  const characters = `SELECT CAST(substr(text.bytes, position.key + 1, ${length}) AS TEXT) AS ch`
    // LIMIT 1 keeps the bytes one value; flattened, every character re-read the word.
    + ` FROM (SELECT CAST(word.value AS BLOB) AS bytes LIMIT 1) AS text,`
    + ` json_each('[' || replace(hex(zeroblob(length(text.bytes))), '00', '0,') || '0]') AS position`
    + ` WHERE ${byte} < x'80' OR ${byte} >= x'C0'`;
  const folded = `(SELECT group_concat(coalesce((SELECT fold.folded FROM ${SEARCH_FOLD_TABLE} AS fold WHERE fold.ch = character.ch), character.ch), '') FROM (${characters}) AS character)`;
  return `(CASE WHEN word.value GLOB '*[^a-z0-9]*' THEN ${folded} ELSE word.value END)`;
}

const TERM = `substr(term.value, 1, ${SEARCH_TERM_MAX_LENGTH})`;
const INSERT = `INSERT INTO ${SEARCH_INDEX_TABLE} (source, doc_id, col, term, tf)`;
const json = (text: string, alias: string) => `json_each('[' || replace(json_quote(${text}), ' ', '","') || ']') AS ${alias}`;

/**
 * SQLite: one term row per distinct term of column `index` of the row NEW,
 * or of every row of `source` (`all`), with its count: the column's text,
 * lower-cased once, split on spaces, each word folded, split again.
 */
function sqliteTermRows(source: SearchSource, index: number, all = false): string {
  const row = all ? "src" : "NEW";
  const text = searchColumnTextSql(source, SEARCH_SOURCES[source][index]![1], row, "sqlite");
  return `${INSERT} SELECT ${quote(source)}, ${row}.id, ${index}, ${TERM}, count(*) FROM ${all ? `${source} AS src, ` : ""}${json(`lower(${text})`, "word")}, ${json(sqliteWordFoldSql(), "term")} WHERE term.value <> '' GROUP BY ${all ? "src.id, " : ""}${TERM}`;
}

/** PostgreSQL: the words (doc_id, col, term) of column `index` of the row `row`. */
function postgresWords(source: SearchSource, index: number, row: string, all: boolean): string {
  const text = searchColumnTextSql(source, SEARCH_SOURCES[source][index]![1], row, "postgres");
  return `SELECT ${row}.id AS doc_id, ${index} AS col, substr(value, 1, ${SEARCH_TERM_MAX_LENGTH}) AS term FROM ${all ? `${source} AS src, ` : ""}`
    + `unnest(string_to_array(scalius_compat.${SEARCH_FOLD_TABLE}(${text}), ' ')) AS word(value) WHERE value <> ''`;
}

/**
 * PostgreSQL: one statement that indexes the row NEW, or every row of
 * `source` (`all`): each column's words, then the term rows and the document
 * row. It never reads the index, so concurrent SERIALIZABLE writers take no
 * predicate locks on it.
 */
function postgresIndexStatement(source: SearchSource, all = false): string {
  const row = all ? "src" : "NEW";
  const words = SEARCH_SOURCES[source].map((_, index) => postgresWords(source, index, row, all));
  const documents = all
    ? `SELECT ${quote(source)}, src.id, -1, '', coalesce(tokens.n, 0) FROM ${source} AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id`
    : `SELECT ${quote(source)}, NEW.id, -1, '', count(*) FROM words`;
  return `WITH words AS (${words.join(" UNION ALL ")}) ${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL ${documents}`;
}

/**
 * PostgreSQL: re-index column `index` of the row NEW alone: its old terms
 * deleted, its new ones written, and the document row's token count moved
 * by the difference (data-modifying CTEs: the index is read only through
 * the rows the statement deletes).
 */
function postgresColumnStatement(source: SearchSource, index: number): string {
  return `WITH gone AS (DELETE FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = OLD.id AND col = ${index} RETURNING tf), `
    + `words AS (${postgresWords(source, index, "NEW", false)}), `
    + `added AS (${INSERT} SELECT ${quote(source)}, doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term RETURNING tf) `
    + `UPDATE ${SEARCH_INDEX_TABLE} SET tf = tf - (SELECT coalesce(sum(tf), 0) FROM gone) + (SELECT coalesce(sum(tf), 0) FROM added) `
    + `WHERE source = ${quote(source)} AND doc_id = NEW.id AND col = -1 AND term = ''`;
}

const documentRow = (source: SearchSource) =>
  `${INSERT} SELECT ${quote(source)}, NEW.id, -1, '', coalesce(sum(tf), 0) FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = NEW.id AND col >= 0`;

/** Index the row NEW of `source`: its terms, then its document row (its token count). */
function indexRowStatements(dialect: SearchIndexDialect, source: SearchSource): string[] {
  if (dialect === "postgres") return [postgresIndexStatement(source)];
  return [...SEARCH_SOURCES[source].map((_, index) => sqliteTermRows(source, index)), documentRow(source)];
}

/** Re-index column `index` of the row NEW of `source` alone, and its document row. */
function indexColumnStatements(dialect: SearchIndexDialect, source: SearchSource, index: number): string[] {
  if (dialect === "postgres") return [postgresColumnStatement(source, index)];
  return [
    `DELETE FROM ${SEARCH_INDEX_TABLE} WHERE source = ${quote(source)} AND doc_id = OLD.id AND (col = ${index} OR col = -1)`,
    sqliteTermRows(source, index),
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
 * (every column again), and one per indexed column that re-indexes that
 * column alone when it changes, so a name edit never re-reads a 10,000
 * character description and a price or stock write fires none. An insert
 * compiles only its own source's trigger (Turso compiles every nested
 * trigger program per statement, without SQLite's cache).
 */
export function searchIndexTriggers(dialect: SearchIndexDialect): SearchIndexTrigger[] {
  return (Object.keys(SEARCH_SOURCES) as SearchSource[]).flatMap((source) => {
    const body = (statements: string[]) => `BEGIN\n  ${statements.join(";\n  ")};\nEND`;
    const name = (event: string) => `${SEARCH_INDEX_TABLE}_${source}_${event}`;
    const columns = SEARCH_SOURCES[source].map(([, column], index) => ({ column, index })).filter(({ column }) => column !== "id");
    return [
      { name: name("insert"), sql: `CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${source}\n${body(indexRowStatements(dialect, source))}` },
      {
        name: name("update"),
        sql: `CREATE TRIGGER ${name("update")} AFTER UPDATE OF id ON ${source}\nWHEN OLD.id IS NOT NEW.id\n`
          + body([deleteRow(source), ...indexRowStatements(dialect, source)]),
      },
      ...columns.map(({ column, index }) => ({
        name: name(`update_${index}`),
        sql: `CREATE TRIGGER ${name(`update_${index}`)} AFTER UPDATE OF ${column} ON ${source}\n`
          + `WHEN OLD.${column} IS NOT NEW.${column} AND OLD.id IS NEW.id\n`
          + body(indexColumnStatements(dialect, source, index)),
      })),
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
 * Migration 0219 on Turso: the fold table (full FTS5 fold, rich text read
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
