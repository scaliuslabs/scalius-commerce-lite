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
import { FTS5_FILL_ROW_COST, FTS5_INDEX_WRITES_KEY, FTS5_MIGRATION_ROWS, SEARCH_SOURCES, fts5ColumnNames, fts5ColumnValueSql, fts5FormsDifferSql, fts5NewFormValuesSql, fts5OldFormValuesSql, fts5OldThroughKey, fts5OldThroughSql, searchColumnChangedSql, searchWatchedColumns, type SearchSource } from "../src/search-index";

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

/** A source's FTS5 columns as its table declares them (`fts5ColumnNames`; two differ from their source column since 0000). */
function fts5Columns(source: SearchSource): string[] {
  return fts5ColumnNames(source);
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

/** The guarded before/after update triggers of one source as 0157 and 0169 installed them. */
export function fts5UpdateGuardTriggers(source: SearchSource, { current = true }: { current?: boolean } = {}): Fts5UpdateTrigger[] {
  if (current) return fts5SearchTextTriggers(source).filter((trigger) => /_fts_(?:before|after)_update$/.test(trigger.name));
  const columns = SEARCH_SOURCES[source];
  const table = `${source}_fts`;
  const sourceColumns = columns.map(([, column]) => column);
  // The row identity first: rowid, then the id when a column indexes it (0157's order).
  const guard = ["rowid", ...sourceColumns.filter((column) => column === "id"), ...sourceColumns.filter((column) => column !== "id")]
    .map((column, index) => `${index === 0 ? "WHEN" : "  OR"} OLD.${id(column)} IS NOT NEW.${id(column)}`)
    .join("\n");
  const ftsColumns = fts5Columns(source).map(id).join(", ");
  const values = (image: "OLD" | "NEW") => columns.map(([, column]) => indexedValue(source, column, image, false)).join(", ");
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

/** Every FTS5 source on D1. */
export const FTS5_SOURCES = Object.keys(SEARCH_SOURCES) as SearchSource[];

export const FTS5_HTML_TEXT_MIGRATION = "0219_search_plain_text_and_unicode_fold";

/**
 * The FTS5 triggers of a source as 0219 installs them: the four names every
 * store has had since 0000, one write each. A row's form follows from its
 * rowid and the table's old-through rowid (`fts5OldThroughSql`): a row above
 * it is indexed in the current form (`fts5ColumnValueSql`), a row at or below
 * it in the raw form every trigger before 0219 wrote. Each trigger reads the
 * boundary once (`zone`) and hands FTS5 each column in its row's form through
 * a parenthesised CASE inside its INSERT ... SELECT (0123's deployed shape:
 * remote D1 splits the file and ends a trigger at an uppercase `END` followed
 * by whitespace or `;`, so a body's CASE ends `END)`; it also refuses a body
 * that is a `SELECT CASE WHEN` statement). An update
 * fires when an indexed column changes in its row's form: the current form
 * also watches a rich-text column's search text. The fill moves the boundary
 * down only after it rewrote the rows it passes, in the same batch, so every
 * delete removes exactly what was indexed. Precedent on remote D1: FTS5
 * writes and the 'delete' command inside triggers (0000, 0157, 0169),
 * `UPDATE OF` (0036), a scalar subquery in a WHEN clause (0100).
 */
export function fts5SearchTextTriggers(source: SearchSource): Fts5UpdateTrigger[] {
  const table = `${source}_fts`;
  const ftsColumns = fts5Columns(source).map(id).join(", ");
  const sourceColumns = [...new Set(SEARCH_SOURCES[source].map(([, column]) => column))];
  const oldThrough = fts5OldThroughSql(source);
  const above = (image: "OLD" | "NEW") => `${image}.${id("rowid")} > ${oldThrough}`;
  const values = (image: "OLD" | "NEW") => {
    const raw = fts5OldFormValuesSql(source, image);
    return fts5NewFormValuesSql(source, image)
      .map((current, index) => current === raw[index] ? current : `(CASE WHEN zone.${id("current")} THEN ${current} ELSE ${raw[index]} END)`)
      .join(", ");
  };
  const changedCurrent = sourceColumns.map((column) => searchColumnChangedSql(source, column)).join("\n    OR ");
  const changedRaw = sourceColumns.map((column) => `OLD.${id(column)} IS NOT NEW.${id(column)}`).join("\n    OR ");
  // The boundary is read only once a column changed: a save that rewrites the same text reads nothing.
  const changed = (image: "OLD" | "NEW") => `((${changedCurrent})\n    AND ${above(image)})\n  OR ((${changedRaw})\n    AND ${image}.${id("rowid")} <= ${oldThrough})`;
  const event = `UPDATE OF ${searchWatchedColumns(source).map(id).join(", ")}`;
  const trigger = (name: string, timing: string, when: string | undefined, body: string): Fts5UpdateTrigger => ({
    name: `${source}_fts_${name}`,
    source,
    sql: [`CREATE TRIGGER ${id(`${source}_fts_${name}`)}`, `${timing} ON ${id(source)}`, ...(when ? [`WHEN ${when}`] : []), "BEGIN", body, "END"].join("\n"),
  });
  const zone = (image: "OLD" | "NEW") => `FROM (SELECT ${above(image)} AS ${id("current")}) AS zone`;
  const insert = `  INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns})\n  SELECT NEW.${id("rowid")}, ${values("NEW")}\n  ${zone("NEW")};`;
  const remove = `  INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns})\n  SELECT 'delete', OLD.${id("rowid")}, ${values("OLD")}\n  ${zone("OLD")};`;
  return [
    trigger("after_insert", "AFTER INSERT", undefined, insert),
    trigger("before_delete", "BEFORE DELETE", undefined, remove),
    trigger("before_update", `BEFORE ${event}`, changed("OLD"), remove),
    trigger("after_update", `AFTER ${event}`, changed("NEW"), insert),
  ];
}

/**
 * Every statement 0219 runs on D1, per source: its FTS5 triggers replaced
 * (`fts5SearchTextTriggers`), and its newest rows (FTS5_MIGRATION_ROWS) made
 * current: only a row whose current form differs from its raw form is
 * written, its raw-form entries deleted first. A table with more rows
 * records its old-through rowid, the newest row left to the scheduled fill,
 * so the migration's writes are bounded whatever the store's size. Every
 * table and its entries stay in place, so every row stays findable. Never run
 * FTS5's `rebuild` or a rank-1 `integrity-check` on these tables: their
 * content is the raw table, which the current form does not index.
 */
export function fts5SearchTextStatements(): string[] {
  return [...FTS5_SOURCES.flatMap((source) => fts5SourceStatements(source)), indexWritesStatement()];
}

/**
 * Today's count of background index writes (`@scalius/core/search`
 * readIndexWriteBudget), started with the rows this migration rewrote at
 * twice FTS5_FILL_ROW_COST each (a migration cannot read what D1 reports it
 * wrote, and FTS5's segment merges cost more on a large index: 50,000 Bangla
 * products measured about seven rows written per row rewritten): the
 * scheduled backfill and fill then keep the day under its ceiling.
 */
function indexWritesStatement(): string {
  const rewritten = FTS5_SOURCES.map((source) => `(SELECT count(*) FROM ${id(source)} AS src WHERE src.${id("rowid")} > ${fts5OldThroughSql(source)} AND ${fts5FormsDifferSql(source, "src")})`).join(" + ");
  // Only when it rewrote a row: a new store writes nothing here (no settings row, no cache key).
  return `INSERT INTO ${id("settings")} (${id("id")}, ${id("category")}, ${id("key")}, ${id("type")}, ${id("value")}) SELECT 'maintenance:${FTS5_INDEX_WRITES_KEY}', 'maintenance', '${FTS5_INDEX_WRITES_KEY}', 'string', date('now') || ':' || (${FTS5_FILL_ROW_COST * 2} * rewritten.rows) FROM (SELECT ${rewritten} AS rows) AS rewritten WHERE rewritten.rows > 0;`;
}

/** The table's old-through rowid, when it has more rows than 0219 indexes itself: its (bound + 1)-th newest row. */
function oldThroughStatement(source: SearchSource): string {
  const key = fts5OldThroughKey(source);
  return `INSERT INTO ${id("settings")} (${id("id")}, ${id("category")}, ${id("key")}, ${id("type")}, ${id("value")}) SELECT 'maintenance:${key}', 'maintenance', '${key}', 'string', CAST(boundary.${id("rowid")} AS TEXT) FROM (SELECT ${id("rowid")} FROM ${id(source)} ORDER BY ${id("rowid")} DESC LIMIT 1 OFFSET ${FTS5_MIGRATION_ROWS[source]}) AS boundary;`;
}

function fts5SourceStatements(source: SearchSource): string[] {
  const triggers = fts5SearchTextTriggers(source);
  const table = `${source}_fts`;
  const ftsColumns = fts5Columns(source).map(id).join(", ");
  const legacy = ["after_insert", "before_delete", "before_update", "after_update"].map((name) => `${source}_fts_${name}`);
  const dropped = [...new Set([...legacy, ...triggers.map((trigger) => trigger.name)])].map((name) => `DROP TRIGGER IF EXISTS ${id(name)};`);
  // Only a row above the boundary whose current form differs from its raw form is written again.
  const changed = `src.${id("rowid")} > ${fts5OldThroughSql(source)} AND ${fts5FormsDifferSql(source, "src")}`;
  return [
    ...dropped,
    oldThroughStatement(source),
    `INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns}) SELECT 'delete', src.${id("rowid")}, ${fts5OldFormValuesSql(source, "src").join(", ")} FROM ${id(source)} AS src WHERE ${changed};`,
    `INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns}) SELECT src.${id("rowid")}, ${fts5NewFormValuesSql(source, "src").join(", ")} FROM ${id(source)} AS src WHERE ${changed};`,
    ...triggers.map((trigger) => `${trigger.sql};`),
  ];
}
