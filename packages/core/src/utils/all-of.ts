import { sql, type SQL } from "drizzle-orm";

/**
 * The conjunction of `conditions` as a balanced tree, or undefined when there
 * is none. SQLite parses `a AND b AND c` left-deep, so the first of n terms
 * sits n - 1 levels down, and D1 refuses an expression tree deeper than 100:
 * a listing's deepest term (the price filter's SKU availability chain, about
 * 70 levels) plus a dozen filters behind it passed that. Balanced, every term
 * is at most ceil(log2 n) levels down. SQLite splits nested ANDs into the same
 * WHERE terms, so the plan and the order the terms are tested in do not change.
 */
export function allOf(conditions: ReadonlyArray<SQL | undefined>): SQL | undefined {
    const terms = conditions.filter((condition): condition is SQL => condition !== undefined);
    if (terms.length === 0) return undefined;
    const join = (from: number, to: number): SQL => {
        if (to - from === 1) return sql`(${terms[from]!})`;
        const middle = from + Math.ceil((to - from) / 2);
        return sql`(${join(from, middle)} AND ${join(middle, to)})`;
    };
    return join(0, terms.length);
}
