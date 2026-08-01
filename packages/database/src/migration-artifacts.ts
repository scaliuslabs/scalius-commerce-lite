import {
  getDatabaseProviderCapabilities,
  type DatabaseProvider,
} from "./provider";

export const DRIZZLE_STATEMENT_BREAKPOINT = "--> statement-breakpoint";

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
    /^CREATE\s+VIRTUAL\s+TABLE\s+[`"]?[a-z0-9_]+_fts[`"]?\s+USING\s+fts5\b/i.test(sql) ||
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
 * Compile one canonical SQLite migration for a concrete provider capability
 * set. D1 receives the byte-identical migration. Turso MVCC omits only FTS5
 * virtual-table maintenance, which its current engine rejects.
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
 * temporarily defers enforcement. The control plane must run
 * `PRAGMA foreign_key_check` before accepting the target fingerprint.
 */
export function compileSqliteDataExportForProvider(
  dataExportSql: string,
  provider: DatabaseProvider,
): string {
  if (provider === "d1") return dataExportSql;
  if (!dataExportSql.trim()) {
    throw new Error("SQLite data export must not be empty.");
  }

  const exportBody = dataExportSql.replace(
    /^\s*PRAGMA\s+defer_foreign_keys\s*=\s*TRUE\s*;\s*/i,
    "",
  );
  return [
    "PRAGMA foreign_keys=OFF;",
    "BEGIN;",
    exportBody.trim(),
    "COMMIT;",
    "PRAGMA foreign_keys=ON;",
    "",
  ].join("\n");
}
