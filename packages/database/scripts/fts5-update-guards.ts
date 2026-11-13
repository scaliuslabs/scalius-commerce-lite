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
import { SEARCH_NORMALIZATION, SEARCH_PLAIN_MAX_LENGTH, SEARCH_RAW_MAX_LENGTH, SEARCH_SOURCES, SEARCH_TEXT_COLUMNS, fts5ColumnValueSql, searchColumnChangedSql, searchWatchedColumns, type SearchSource } from "../src/search-index";

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
  return [
    {
      name: before,
      source,
      sql: [
        `CREATE TRIGGER ${id(before)}`,
        `BEFORE ${event} ON ${id(source)}`,
        currentGuard,
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

/** The sources whose 0000 FTS5 table named a column their content table lacks (`pages_fts.content_col`, `orders_fts.order_id`): 0219 makes them again. */
export const FTS5_RENAMED_SOURCES: readonly SearchSource[] = FTS5_SOURCES.filter((source) => SEARCH_SOURCES[source].some(([ftsColumn, column]) => ftsColumn !== column));

/** A source's FTS5 table as 0219 makes it: external content, the source's own column names, and the tokenizer 0000 gave it. */
export function fts5TableSql(source: SearchSource): string {
  return [
    `CREATE VIRTUAL TABLE ${id(`${source}_fts`)} USING fts5(`,
    ...fts5Columns(source, true).map((column) => `  ${id(column)},`),
    `  content='${source}',`,
    "  content_rowid='rowid',",
    `  tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"`,
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
 * it fills it. pages_fts and orders_fts, whose 0000 tables named a column
 * their source lacks, are made again with the source's names and every row
 * indexed once. The tables keep their external content: never run FTS5's
 * `rebuild` on them.
 */
export function fts5SearchTextStatements(): string[] {
  return FTS5_SOURCES.flatMap((source) => {
    const triggers = fts5SearchTextTriggers(source);
    const table = `${source}_fts`;
    const columns = SEARCH_SOURCES[source];
    const values = columns.map(([, column]) => indexedValue(source, column, "src", true)).join(", ");
    if (FTS5_RENAMED_SOURCES.includes(source)) {
      // Its 0000 table named a column its source lacks: made again with the
      // source's names, and every row indexed once.
      return [
        ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${id(trigger.name)};`),
        `DROP TABLE IF EXISTS ${id(table)};`,
        `${fts5TableSql(source)};`,
        ...triggers.map((trigger) => `${trigger.sql};`),
        `INSERT INTO ${id(table)} (${id("rowid")}, ${fts5Columns(source, true).map(id).join(", ")}) SELECT ${id("rowid")}, ${values} FROM ${id(source)} AS src;`,
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
  });
}
