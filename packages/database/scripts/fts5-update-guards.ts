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
import { SEARCH_HTML_COLUMNS, SEARCH_NORMALIZATION, SEARCH_SOURCES, SEARCH_TEXT_MAX_LENGTH, searchColumnTextSql, type SearchSource } from "../src/search-index";

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

export interface Fts5UpdateTrigger {
  name: string;
  source: SearchSource;
  sql: string;
}

/**
 * The value FTS5 indexes for a source column of the row `image`: from 0219
 * the column's text as every provider reads it (`searchColumnTextSql`: a
 * rich-text column without markup, the first 10,000 characters, normalised).
 * `current: false` renders the column as 0157 and 0169 did.
 */
function indexedValue(source: SearchSource, column: string, image: string, current: boolean): string {
  return current ? searchColumnTextSql(source, column, image, "sqlite", { normalize: true }) : `${image}.${id(column)}`;
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
  const ftsColumns = columns.map(([ftsColumn]) => id(ftsColumn)).join(", ");
  const values = (image: "OLD" | "NEW") => columns.map(([, column]) => indexedValue(source, column, image, current)).join(", ");
  const before = `${source}_fts_before_update`;
  const after = `${source}_fts_after_update`;
  return [
    {
      name: before,
      source,
      sql: [
        `CREATE TRIGGER ${id(before)}`,
        `BEFORE UPDATE ON ${id(source)}`,
        guard,
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
        `AFTER UPDATE ON ${id(source)}`,
        guard,
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

/** A source's FTS5 insert and delete triggers, reading each column's text as every provider does (0219). */
export function fts5InsertDeleteTriggers(source: SearchSource): Fts5UpdateTrigger[] {
  const columns = SEARCH_SOURCES[source];
  const table = `${source}_fts`;
  const ftsColumns = columns.map(([ftsColumn]) => id(ftsColumn)).join(", ");
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
 * by ones that index the text every provider reads (searchColumnTextSql),
 * then the rows whose indexed text changes indexed again: every row of a
 * source with a rich-text column (its table emptied first), and elsewhere
 * only the rows that hold a character the index now normalises or a column
 * past SEARCH_TEXT_MAX_LENGTH (removed with the values the old triggers
 * indexed, the raw columns). The tables keep their external content (the
 * source rows hold the markup): never run FTS5's `rebuild` on them, which
 * would index the raw text again (`__tests__/search-plain-text-migration.test.ts`
 * refuses one anywhere in the code).
 */
export function fts5SearchTextStatements(): string[] {
  return FTS5_SOURCES.flatMap((source) => {
    const triggers = fts5SearchTextTriggers(source);
    const table = `${source}_fts`;
    const columns = SEARCH_SOURCES[source];
    const ftsColumns = columns.map(([ftsColumn]) => id(ftsColumn)).join(", ");
    const reinsert = (where: string) => `INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns}) SELECT ${id("rowid")}, ${columns.map(([, column]) => indexedValue(source, column, "src", true)).join(", ")} FROM ${id(source)} AS src${where};`;
    const replaced = [
      ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${id(trigger.name)};`),
      ...triggers.map((trigger) => `${trigger.sql};`),
    ];
    if (SEARCH_HTML_COLUMNS[source]) {
      return [...replaced, `INSERT INTO ${id(table)} (${id(table)}) VALUES ('delete-all');`, reinsert("")];
    }
    const characters = [...SEARCH_NORMALIZATION.keys()].map((character) => `char(${character.codePointAt(0)})`);
    const affected = ` WHERE ${[...new Set(columns.map(([, column]) => column))].flatMap((column) => [
      ...characters.map((character) => `instr(src.${id(column)}, ${character}) > 0`),
      `length(src.${id(column)}) > ${SEARCH_TEXT_MAX_LENGTH}`,
    ]).join(" OR ")}`;
    return [
      ...replaced,
      `INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns}) SELECT 'delete', ${id("rowid")}, ${columns.map(([, column]) => `src.${id(column)}`).join(", ")} FROM ${id(source)} AS src${affected};`,
      reinsert(affected),
    ];
  });
}
