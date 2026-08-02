export const POSTGRES_MIGRATION_CONTROL_SCHEMA = "_scalius_migration" as const;
export const POSTGRES_MIGRATION_STATE_TABLE = "sqlite_to_postgres_state" as const;
export const POSTGRES_MIGRATION_RECEIPTS_TABLE = "sqlite_to_postgres_receipts" as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function postgresMigrationControlTable(table: string): string {
  return `${quoteIdentifier(POSTGRES_MIGRATION_CONTROL_SCHEMA)}.${quoteIdentifier(table)}`;
}

export const POSTGRES_MIGRATION_STATE_REGCLASS =
  `${POSTGRES_MIGRATION_CONTROL_SCHEMA}.${POSTGRES_MIGRATION_STATE_TABLE}` as const;

/** Shared lock identity for initial SQLite imports and later schema upgrades. */
export const POSTGRES_MIGRATION_LOCK_KEY_SQL =
  "hashtextextended('scalius-sqlite-to-postgres:' || current_database(), 0)" as const;
