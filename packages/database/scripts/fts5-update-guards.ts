/**
 * The update triggers of D1's FTS5 tables (`<source>_fts`, external content):
 * the BEFORE trigger removes the row's indexed text and the AFTER trigger
 * adds it again. Their WHEN clause fires them only when the row identity or
 * an indexed column changes, so a write of any other column (a SKU's stock,
 * a product's revision, a checkout's progress) costs no FTS5 delete, insert
 * and segment merge. The pair shares one guard, so the index stays exactly
 * in step with the rows. Migration 0157 installed the `orders` pair and 0169
 * the rest, each verbatim (`__tests__/fts5-update-guards.test.ts`). Turso and
 * PostgreSQL keep `search_fts_terms`, whose triggers carry the same guard
 * (`src/search-index.ts`).
 */
import { FTS5_CONTENT_VIEW_SOURCES, FTS5_REINDEX_CURSOR_KEY, SEARCH_NORMALIZATION, SEARCH_PLAIN_MAX_LENGTH, SEARCH_RAW_MAX_LENGTH, SEARCH_SOURCES, SEARCH_TEXT_COLUMNS, fts5ColumnValueSql, isFts5ContentViewSource, searchColumnChangedSql, searchWatchedColumns, type Fts5ContentViewSource, type SearchSource } from "../src/search-index";

/** The sources 0169 guards (orders: 0157; categories and product reviews fire on `UPDATE OF` their columns). */
export const FTS5_GUARDED_SOURCES = [
  "products",
  "product_variants",
  "pages",
  "customers",
  "abandoned_checkouts",
  "navigation_menu_items",
] as const satisfies readonly SearchSource[];

export const FTS5_UPDATE_GUARD_MIGRATION = "0169_fk_indexes_and_trigger_guards";

const id = (name: string) => `\`${name}\``;

/**
 * A source's FTS5 columns: as 0000 named them before 0219 (`SEARCH_SOURCES`'
 * first names: `content_col`, `order_id`), its own source columns from 0219.
 * An external-content table reads `T.<column>` from its source whenever it
 * needs a value (a full count, `snippet()`, `integrity-check` against the
 * content), so every column must exist there.
 */
function fts5Columns(source: SearchSource, current: boolean): string[] {
  return SEARCH_SOURCES[source].map(([ftsColumn, column]) => current ? column : ftsColumn);
}

export interface Fts5UpdateTrigger {
  name: string;
  source: SearchSource;
  sql: string;
}

/**
 * The value FTS5 indexes for a source column of the row `image`: from 0219
 * the value every provider reads (`fts5ColumnValueSql`: a rich-text column's
 * search text, or the raw column while it has none; any other column's first
 * 2,000 characters, normalised). `current: false` renders the column as 0157
 * and 0169 did.
 */
function indexedValue(source: SearchSource, column: string, image: string, current: boolean): string {
  return current ? fts5ColumnValueSql(source, column, image) : `${image}.${id(column)}`;
}

/**
 * A content-view table (FTS5_CONTENT_VIEW_SOURCES) holds a row only once the
 * scheduled re-index or a write indexed it, so its delete and the delete half
 * of its update run only for an indexed row (FTS5 keeps one `_docsize` row
 * per indexed row): removing terms a row never added would corrupt the index.
 */
const indexedRow = (source: SearchSource) => `EXISTS (SELECT 1 FROM ${id(`${source}_fts_docsize`)} WHERE ${id("id")} = OLD.${id("rowid")})`;

/** The guarded before/after update triggers of one source, as `CREATE TRIGGER` statements (`current: false`: as 0169 installed them). */
export function fts5UpdateGuardTriggers(source: SearchSource, { current = true }: { current?: boolean } = {}): Fts5UpdateTrigger[] {
  const columns = SEARCH_SOURCES[source];
  const table = `${source}_fts`;
  const sourceColumns = columns.map(([, column]) => column);
  // The row identity first: rowid, then the id when a column indexes it (0157's order).
  const guard = ["rowid", ...sourceColumns.filter((column) => column === "id"), ...sourceColumns.filter((column) => column !== "id")]
    .map((column, index) => `${index === 0 ? "WHEN" : "  OR"} OLD.${id(column)} IS NOT NEW.${id(column)}`)
    .join("\n");
  const ftsColumns = fts5Columns(source, current).map(id).join(", ");
  const values = (image: "OLD" | "NEW") => columns.map(([, column]) => indexedValue(source, column, image, current)).join(", ");
  const before = `${source}_fts_before_update`;
  const after = `${source}_fts_after_update`;
  // From 0219 the triggers name the columns they read: a price, stock or status write neither fires
  // nor compiles them (a rowid change, which nothing writes, no longer re-indexes the row).
  const event = current ? `UPDATE OF ${searchWatchedColumns(source).map(id).join(", ")}` : "UPDATE";
  // From 0219 the guard compares what each column indexes (`searchColumnChangedSql`).
  const currentGuard = current
    ? [...new Set(sourceColumns)].map((column, index) => `${index === 0 ? "WHEN" : "  OR"} ${searchColumnChangedSql(source, column)}`).join("\n")
    : guard;
  const beforeGuard = current && isFts5ContentViewSource(source)
    ? `WHEN (${[...new Set(sourceColumns)].map((column) => searchColumnChangedSql(source, column)).join("\n  OR ")})\n  AND ${indexedRow(source)}`
    : currentGuard;
  return [
    {
      name: before,
      source,
      sql: [
        `CREATE TRIGGER ${id(before)}`,
        `BEFORE ${event} ON ${id(source)}`,
        beforeGuard,
        "BEGIN",
        `  INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns})`,
        `  VALUES ('delete', OLD.${id("rowid")}, ${values("OLD")});`,
        "END",
      ].join("\n"),
    },
    {
      name: after,
      source,
      sql: [
        `CREATE TRIGGER ${id(after)}`,
        `AFTER ${event} ON ${id(source)}`,
        currentGuard,
        "BEGIN",
        `  INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns})`,
        `  VALUES (NEW.${id("rowid")}, ${values("NEW")});`,
        "END",
      ].join("\n"),
    },
  ];
}

/** Every statement 0169 runs for them: each source's old pair dropped, then the guarded pair. */
export function fts5UpdateGuardStatements(): string[] {
  return FTS5_GUARDED_SOURCES.flatMap((source) => {
    const triggers = fts5UpdateGuardTriggers(source, { current: false });
    return [
      ...triggers.map((trigger) => `DROP TRIGGER ${id(trigger.name)};`),
      ...triggers.map((trigger) => `${trigger.sql};`),
    ];
  });
}

/** Every FTS5 source on D1: 0219 replaces all four triggers of each. */
export const FTS5_SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];

export const FTS5_HTML_TEXT_MIGRATION = "0219_search_plain_text_and_unicode_fold";

/** The FTS5 tables made with FTS5's default tokenizer (0000); every other one splits as unicode61 with marks kept. */
const DEFAULT_TOKENIZER: readonly SearchSource[] = ["product_variants", "abandoned_checkouts"];

/** A content-view source's view: each column as its triggers index it (`fts5ColumnValueSql`), keyed by the source's rowid. */
export function fts5ContentViewSql(source: Fts5ContentViewSource): string {
  const columns = SEARCH_SOURCES[source].map(([, column]) => `${indexedValue(source, column, "src", true)} AS ${id(column)}`);
  return `CREATE VIEW ${id(`${source}_fts_content`)} AS SELECT src.${id("rowid")} AS ${id("rowid")}, ${columns.join(", ")} FROM ${id(source)} AS src`;
}

/** A content-view source's FTS5 table as 0219 makes it: its view as content, the source's column names, the tokenizer it had. */
export function fts5TableSql(source: Fts5ContentViewSource): string {
  return [
    `CREATE VIRTUAL TABLE ${id(`${source}_fts`)} USING fts5(`,
    ...fts5Columns(source, true).map((column) => `  ${id(column)},`),
    `  content='${source}_fts_content',`,
    DEFAULT_TOKENIZER.includes(source) ? "  content_rowid='rowid'" : "  content_rowid='rowid',",
    ...(DEFAULT_TOKENIZER.includes(source) ? [] : [`  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"`]),
    ")",
  ].join("\n");
}

/** A source's FTS5 insert and delete triggers, reading each column's text as every provider does (0219). */
export function fts5InsertDeleteTriggers(source: SearchSource): Fts5UpdateTrigger[] {
  const columns = SEARCH_SOURCES[source];
  const table = `${source}_fts`;
  const ftsColumns = fts5Columns(source, true).map(id).join(", ");
  const values = (image: "OLD" | "NEW") => columns.map(([, column]) => indexedValue(source, column, image, true)).join(", ");
  const insert = `${source}_fts_after_insert`;
  const remove = `${source}_fts_before_delete`;
  return [
    {
      name: insert,
      source,
      sql: [
        `CREATE TRIGGER ${id(insert)}`,
        `AFTER INSERT ON ${id(source)}`,
        "BEGIN",
        `  INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns})`,
        `  VALUES (NEW.${id("rowid")}, ${values("NEW")});`,
        "END",
      ].join("\n"),
    },
    {
      name: remove,
      source,
      sql: [
        `CREATE TRIGGER ${id(remove)}`,
        `BEFORE DELETE ON ${id(source)}`,
        ...(isFts5ContentViewSource(source) ? [`WHEN ${indexedRow(source)}`] : []),
        "BEGIN",
        `  INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns})`,
        `  VALUES ('delete', OLD.${id("rowid")}, ${values("OLD")});`,
        "END",
      ].join("\n"),
    },
  ];
}

/** The four FTS5 triggers of a source as 0219 installs them. */
export function fts5SearchTextTriggers(source: SearchSource): Fts5UpdateTrigger[] {
  return [...fts5InsertDeleteTriggers(source), ...fts5UpdateGuardTriggers(source)];
}

/**
 * Every statement 0219 runs on D1: each source's four FTS5 triggers replaced
 * by ones that read what every provider reads (`fts5ColumnValueSql`), then
 * only the rows whose indexed text changes are indexed again: rows holding a
 * character the index now normalises, a short column past
 * SEARCH_PLAIN_MAX_LENGTH or a rich-text one past SEARCH_RAW_MAX_LENGTH,
 * removed with the values the old triggers indexed
 * (the raw columns). A rich-text column indexes its raw value until its
 * companion is filled, as before, so the catalogue is only read (for those
 * characters), not re-indexed: the scheduled backfill re-indexes each row as
 * it fills it. Every table but products_fts and categories_fts
 * (FTS5_CONTENT_VIEW_SOURCES; pages_fts and orders_fts had named a column
 * their source lacks since 0000) is made again, empty, over a content view of
 * what its triggers index: the scheduled re-index fills it a bounded slice at
 * a time, so the migration reads and writes no row of them. Never run FTS5's
 * `rebuild` on products_fts or categories_fts: their content is the raw
 * table.
 */
export function fts5SearchTextStatements(): string[] {
  return [...FTS5_SOURCES.flatMap((source) => fts5SourceStatements(source)), fts5ReindexPendingStatement()];
}

/**
 * The re-index's cursor, written only on a store with a row in some
 * content-view source: a new store has nothing to re-index, and its ticks
 * read no row for it. The re-index deletes it when every table is filled.
 */
export function fts5ReindexPendingStatement(): string {
  const key = FTS5_REINDEX_CURSOR_KEY;
  const rows = FTS5_CONTENT_VIEW_SOURCES.map((source) => `EXISTS (SELECT 1 FROM ${id(source)})`).join(" OR ");
  return `INSERT INTO ${id("settings")} (${id("id")}, ${id("category")}, ${id("key")}, ${id("type")}, ${id("value")}) SELECT 'maintenance:${key}', 'maintenance', '${key}', 'json', '{}' WHERE ${rows} ON CONFLICT DO NOTHING;`;
}

function fts5SourceStatements(source: SearchSource): string[] {
  {
    const triggers = fts5SearchTextTriggers(source);
    const table = `${source}_fts`;
    const columns = SEARCH_SOURCES[source];
    const values = columns.map(([, column]) => indexedValue(source, column, "src", true)).join(", ");
    if (isFts5ContentViewSource(source)) {
      // Made again, empty, over its content view; the scheduled re-index fills it.
      return [
        ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${id(trigger.name)};`),
        `DROP TABLE IF EXISTS ${id(table)};`,
        `${fts5ContentViewSql(source)};`,
        `${fts5TableSql(source)};`,
        ...triggers.map((trigger) => `${trigger.sql};`),
      ];
    }
    const ftsColumns = fts5Columns(source, false).map(id).join(", ");
    const replaced = [
      ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${id(trigger.name)};`),
      ...triggers.map((trigger) => `${trigger.sql};`),
    ];
    const read = [...new Set(columns.map(([, column]) => column))];
    const characters = [...SEARCH_NORMALIZATION.keys()].map((character) => `char(${character.codePointAt(0)})`);
    const affected = ` WHERE ${read.flatMap((column) => [
      ...characters.map((character) => `instr(src.${id(column)}, ${character}) > 0`),
      `length(src.${id(column)}) > ${SEARCH_TEXT_COLUMNS[source]?.[column] ? SEARCH_RAW_MAX_LENGTH : SEARCH_PLAIN_MAX_LENGTH}`,
    ]).join(" OR ")}`;
    return [
      ...replaced,
      `INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns}) SELECT 'delete', ${id("rowid")}, ${columns.map(([, column]) => `src.${id(column)}`).join(", ")} FROM ${id(source)} AS src${affected};`,
      `INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns}) SELECT ${id("rowid")}, ${values} FROM ${id(source)} AS src${affected};`,
    ];
  }
}
