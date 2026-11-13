import {
  getDatabaseProviderCapabilities,
  type DatabaseProvider,
} from "./provider";
import {
  SEARCH_INDEX_TABLE,
  SEARCH_SOURCES,
  searchIndexRebuildStatements,
  searchIndexSqliteMigrationStatements,
  searchIndexSqliteRefreshStatements,
  searchIndexTriggers,
  type SearchSource,
} from "./search-index";

export const DRIZZLE_STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface SqliteTriggerDefinition {
  name: string;
  sql: string;
}

export interface SqliteDataExportEnvelope {
  prefix: string;
  suffix: string;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeTriggerDefinitions(
  definitions: readonly SqliteTriggerDefinition[],
): readonly SqliteTriggerDefinition[] {
  const names = new Set<string>();
  return definitions.map((definition) => {
    const name = definition.name.trim();
    const sql = definition.sql.trim().replace(/;\s*$/, "");
    if (!name) throw new Error("SQLite trigger name must not be empty.");
    if (!/^CREATE\s+TRIGGER\b/i.test(sql)) {
      throw new Error(`SQLite trigger ${JSON.stringify(name)} has invalid SQL.`);
    }
    if (names.has(name)) {
      throw new Error(`SQLite trigger ${JSON.stringify(name)} is duplicated.`);
    }
    names.add(name);
    return { name, sql };
  });
}

function normalizeTableNames(tableNames: readonly string[]): readonly string[] {
  const names = new Set<string>();
  return tableNames.map((tableName) => {
    const name = tableName.trim();
    if (!name) throw new Error("SQLite table name must not be empty.");
    if (names.has(name)) {
      throw new Error(`SQLite table ${JSON.stringify(name)} is duplicated.`);
    }
    names.add(name);
    return name;
  });
}

function stripLeadingSqlComments(statement: string): string {
  let remaining = statement.trimStart();
  while (remaining) {
    if (remaining.startsWith("--")) {
      const newline = remaining.indexOf("\n");
      remaining = newline === -1 ? "" : remaining.slice(newline + 1).trimStart();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end === -1) return remaining;
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return remaining;
}

export function isFts5MigrationStatement(statement: string): boolean {
  const sql = stripLeadingSqlComments(statement);
  return (
    /^CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?[a-z0-9_]+_fts[`"]?\s+USING\s+fts5\b/i.test(sql) ||
    /^(?:CREATE|DROP)\s+TRIGGER\b[\s\S]*?\b[a-z0-9_]+_fts_(?:after|before)_/i.test(sql) ||
    /^INSERT\s+INTO\s+[`"]?[a-z0-9_]+_fts[`"]?\b/i.test(sql)
  );
}

/**
 * These two one-time statements lifted nested legacy navigation JSON into the
 * relational navigation model. A D1 source being copied to Turso has already
 * executed them, and the final navigation tables are copied as normal data.
 */
export function isLegacyNavigationRecursiveBackfill(
  statement: string,
): boolean {
  const sql = stripLeadingSqlComments(statement);
  return /^WITH\s+RECURSIVE\s+(?:header_items|footer_items)\b[\s\S]*?INSERT\s+INTO\s+[`"]?navigation_menu_items[`"]?/i.test(
    sql,
  );
}

/**
 * The statement of migration 0152 that a provider without FTS5 expands into
 * its search index (`search-index.ts`); D1 runs it as a no-op.
 */
export function isSearchIndexMarker(statement: string): boolean {
  return /^SELECT\s+'search_fts_terms'\s*;?\s*$/i.test(stripLeadingSqlComments(statement).trim());
}

/**
 * The statement of migration 0219 that a provider without FTS5 expands into
 * its search index's refresh (the fold table, every trigger, the index
 * rebuilt: `searchIndexSqliteRefreshStatements`); D1 runs it as a no-op.
 */
export function isSearchIndexRefreshMarker(statement: string): boolean {
  return /^SELECT\s+'search_fts_terms:refresh'\s*;?\s*$/i.test(stripLeadingSqlComments(statement).trim());
}

/**
 * The statement of a later migration that rebuilt a search source's table
 * (`SELECT 'search_fts_terms:<source>'`, 0204 for product_reviews): its
 * search index triggers went with the old table, so a provider without FTS5
 * reinstalls them (the index rows are keyed by the row id and stay). D1 runs
 * it as a no-op. Null for any other statement; an unknown source throws.
 */
export function searchIndexSourceMarker(statement: string): SearchSource | null {
  const match = /^SELECT\s+'search_fts_terms:([a-z_]+)'\s*;?\s*$/i.exec(stripLeadingSqlComments(statement).trim());
  if (!match) return null;
  const source = match[1]!;
  if (!Object.hasOwn(SEARCH_SOURCES, source)) throw new Error(`Unknown search index source ${source}.`);
  return source as SearchSource;
}

function searchIndexSourceTriggerStatements(source: SearchSource): string[] {
  const prefix = `${SEARCH_INDEX_TABLE}_${source}_`;
  return searchIndexTriggers("sqlite").filter((trigger) => trigger.name.startsWith(prefix)).map((trigger) => `${trigger.sql};`);
}

/**
 * Compile one canonical SQLite migration for a concrete provider capability
 * set. D1 receives the byte-identical migration. Turso MVCC omits only FTS5
 * virtual-table maintenance, which its current engine rejects, and gets the
 * search index in its place.
 */
export function compileSqliteMigrationForProvider(
  migrationSql: string,
  provider: DatabaseProvider,
): string {
  const capabilities = getDatabaseProviderCapabilities(provider);
  if (
    capabilities.fts5 &&
    capabilities.recursiveCte &&
    capabilities.withoutRowid
  ) {
    return migrationSql;
  }

  const statements = migrationSql.split(DRIZZLE_STATEMENT_BREAKPOINT);
  return statements
    .flatMap((statement) => {
      if (capabilities.fts5) return [statement];
      if (isSearchIndexMarker(statement)) return searchIndexSqliteMigrationStatements().map((compiled) => `${compiled};`);
      if (isSearchIndexRefreshMarker(statement)) return searchIndexSqliteRefreshStatements().map((compiled) => `${compiled};`);
      const source = searchIndexSourceMarker(statement);
      return source ? searchIndexSourceTriggerStatements(source) : [statement];
    })
    .filter(
      (statement) =>
        statement.trim() &&
        (capabilities.fts5 || !isFts5MigrationStatement(statement)) &&
        (capabilities.recursiveCte ||
          !isLegacyNavigationRecursiveBackfill(statement)),
    )
    .map((statement) => {
      const compiled = capabilities.withoutRowid
        ? statement
        : statement.replace(/\)\s+WITHOUT\s+ROWID\s*;/gi, ");");
      return compiled.trim();
    })
    .join(`\n${DRIZZLE_STATEMENT_BREAKPOINT}\n`)
    .concat("\n");
}

/**
 * Wrap a trusted, data-only D1 export in one offline import transaction.
 * D1 emits tables alphabetically, not in foreign-key order, so the target
 * temporarily defers enforcement. The migration operator must run
 * `PRAGMA foreign_key_check` before accepting the target fingerprint.
 */
export function compileSqliteDataExportForProvider(
  dataExportSql: string,
  provider: DatabaseProvider,
  triggerDefinitions: readonly SqliteTriggerDefinition[] = [],
  applicationTables: readonly string[] = [],
): string {
  if (provider === "d1") return dataExportSql;
  if (!dataExportSql.trim()) {
    throw new Error("SQLite data export must not be empty.");
  }

  const exportBody = dataExportSql.replace(
    /^\s*PRAGMA\s+defer_foreign_keys\s*=\s*TRUE\s*;\s*/i,
    "",
  );
  const envelope = createSqliteDataExportEnvelopeForProvider(
    provider,
    triggerDefinitions,
    applicationTables,
  );
  return `${envelope.prefix}${exportBody.trim()}\n${envelope.suffix}`;
}

/**
 * Build the small deterministic wrapper around a potentially multi-gigabyte
 * data-only export. The CLI uses this envelope to stream the export without
 * retaining the database contents in JavaScript memory.
 */
export function createSqliteDataExportEnvelopeForProvider(
  provider: DatabaseProvider,
  triggerDefinitions: readonly SqliteTriggerDefinition[] = [],
  applicationTables: readonly string[] = [],
): SqliteDataExportEnvelope {
  if (provider === "d1") return { prefix: "", suffix: "" };

  const triggers = normalizeTriggerDefinitions(triggerDefinitions);
  const tables = normalizeTableNames(applicationTables);
  const prefix = [
    "PRAGMA foreign_keys=OFF;",
    "BEGIN;",
    ...triggers.map(
      (trigger) => `DROP TRIGGER IF EXISTS ${quoteSqliteIdentifier(trigger.name)};`,
    ),
    ...tables.map(
      (table) => `DELETE FROM ${quoteSqliteIdentifier(table)};`,
    ),
    "",
  ].join("\n");
  // The imported rows bypassed the search index triggers (a D1 export has no
  // index rows to copy): a target with the index rebuilds it.
  const searchIndexed = triggers.some((trigger) => trigger.name.startsWith(`${SEARCH_INDEX_TABLE}_`));
  const suffix = [
    ...triggers.map((trigger) => `${trigger.sql};`),
    ...(searchIndexed ? searchIndexRebuildStatements("sqlite").map((statement) => `${statement};`) : []),
    "COMMIT;",
    "PRAGMA foreign_keys=ON;",
    "",
  ].join("\n");

  return { prefix, suffix };
}
