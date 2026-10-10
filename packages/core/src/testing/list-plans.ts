// Test helper: the query plan of a dashboard list's page-ids subquery.
//
// A list's data statement reads its wide rows `WHERE id IN (SELECT id ...
// ORDER BY ... LIMIT ...)`. These are the plan steps of that subquery (its
// own steps, not those of subqueries nested in it). D1 keeps no table
// statistics, so an empty test database plans exactly as a large store.
import type { DatabaseSync } from "node:sqlite";

export interface CapturedQuery {
    query: string;
    values: readonly unknown[];
}

interface PlanRow { id: number; parent: number; detail: string }

/** The page-ids subquery's plan in the first captured statement matching `statement`, joined with " | ". */
export function pageKeysPlan(sqlite: DatabaseSync, queries: readonly CapturedQuery[], statement: RegExp): string {
    const data = queries.find(({ query }) => statement.test(query));
    if (!data) throw new Error(`No captured statement matches ${statement}`);
    const values = data.values.map((value) => typeof value === "boolean" ? Number(value) : value) as never[];
    const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${data.query}`).all(...values) as unknown as PlanRow[];
    const root = rows.find((row) => /^LIST SUBQUERY/.test(row.detail));
    if (!root) throw new Error("The statement has no page-ids subquery");
    return rows.filter((row) => row.parent === root.id).map((row) => row.detail).join(" | ");
}

/** A plan step that sorts the rows a page walks (instead of reading them in index order). */
export const SORTS_THE_TABLE = /USE TEMP B-TREE FOR (LAST TERM OF )?ORDER BY/;
