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
import { FTS5_MIGRATION_ROWS, SEARCH_SOURCES, fts5ColumnNames, fts5ColumnValueSql, fts5FormsDifferSql, fts5NewFormValuesSql, fts5OldFormValuesSql, fts5OldThroughKey, fts5OldThroughSql, searchColumnChangedSql, searchWatchedColumns, type SearchSource } from "../src/search-index";

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
 * The FTS5 triggers of a source as 0219 installs them. A row's form follows
 * from its rowid and the table's old-through rowid (`fts5OldThroughSql`, read
 * in each WHEN clause as 0100's cache-clock triggers read cache_clock): a row
 * above it is indexed in the current form (`fts5ColumnValueSql`), a row at or
 * below it in the raw form every trigger before 0219 wrote. Each write keeps
 * its row in its zone's form, and
 * the fill moves the boundary down only after it rewrote the rows it passes,
 * in the same batch, so every delete removes exactly what was indexed. Once a
 * table is current (no cursor row) the old-zone triggers never fire.
 * Precedent on remote D1: FTS5 writes and the 'delete' command inside
 * triggers (0000, 0157, 0169), `UPDATE OF` (0036), a scalar subquery in a
 * WHEN clause (0100).
 */
export function fts5SearchTextTriggers(source: SearchSource): Fts5UpdateTrigger[] {
  const table = `${source}_fts`;
  const ftsColumns = fts5Columns(source).map(id).join(", ");
  const sourceColumns = [...new Set(SEARCH_SOURCES[source].map(([, column]) => column))];
  const oldThrough = fts5OldThroughSql(source);
  const zone = (image: "OLD" | "NEW", current: boolean) => `${image}.${id("rowid")} ${current ? ">" : "<="} ${oldThrough}`;
  const values = (image: "OLD" | "NEW", current: boolean) => (current ? fts5NewFormValuesSql(source, image) : fts5OldFormValuesSql(source, image)).join(", ");
  const changed = (current: boolean) => current
    ? sourceColumns.map((column) => searchColumnChangedSql(source, column)).join("\n  OR ")
    : sourceColumns.map((column) => `OLD.${id(column)} IS NOT NEW.${id(column)}`).join("\n  OR ");
  const forms = [true, false];
  return forms.flatMap((current) => {
    const suffix = current ? "" : "_old";
    // The current form reads a rich-text column's search text too; the raw form its raw columns only.
    const watched = current ? searchWatchedColumns(source) : sourceColumns;
    const event = `UPDATE OF ${watched.map(id).join(", ")}`;
    const trigger = (name: string, timing: string, when: string, body: string): Fts5UpdateTrigger => ({
      name: `${source}_fts_${name}${suffix}`,
      source,
      sql: [`CREATE TRIGGER ${id(`${source}_fts_${name}${suffix}`)}`, `${timing} ON ${id(source)}`, `WHEN ${when}`, "BEGIN", body, "END"].join("\n"),
    });
    const insert = (image: "NEW") => `  INSERT INTO ${id(table)} (${id("rowid")}, ${ftsColumns})\n  VALUES (${image}.${id("rowid")}, ${values(image, current)});`;
    const remove = `  INSERT INTO ${id(table)} (${id(table)}, ${id("rowid")}, ${ftsColumns})\n  VALUES ('delete', OLD.${id("rowid")}, ${values("OLD", current)});`;
    return [
      trigger("after_insert", "AFTER INSERT", zone("NEW", current), insert("NEW")),
      trigger("before_delete", "BEFORE DELETE", zone("OLD", current), remove),
      trigger("before_update", `BEFORE ${event}`, `(${changed(current)})\n  AND ${zone("OLD", current)}`, remove),
      trigger("after_update", `AFTER ${event}`, `(${changed(current)})\n  AND ${zone("NEW", current)}`, insert("NEW")),
    ];
  });
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
  return FTS5_SOURCES.flatMap((source) => fts5SourceStatements(source));
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
