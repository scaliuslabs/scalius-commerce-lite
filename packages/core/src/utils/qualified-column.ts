import { Column, getTableName, is, sql, type AnyColumn, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Keeps an outer column qualified inside a scalar SELECT expression. Drizzle
 * strips Column qualification in single-table selections; a nested query's
 * same-named column would otherwise capture the reference. Identifier nodes
 * retain the scope and quote names safely, including aliased tables.
 */
export function qualifiedColumn(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * `qualifiedColumn` for a SQL helper's column-or-expression argument: a
 * Column keeps its table, any other expression is used as given. A helper
 * that embeds a caller's column in a subquery goes through this, so its
 * correlation never depends on how many tables the caller's select names.
 */
export function qualifiedReference(value: SQLWrapper): SQLWrapper {
  return is(value, Column) ? qualifiedColumn(value as AnyColumn) : value;
}
