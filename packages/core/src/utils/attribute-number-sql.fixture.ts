// Test support for the SQL twin of `canonicalAttributeNumber`: numbers at
// every edge an attribute's range has, and the text a provider's SQL writes
// for them (the D1 and PostgreSQL tests compare it with the TypeScript text).
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

import { canonicalAttributeNumberSql } from "./attribute-number-sql";

/** Past PostgreSQL's 32-bit INTEGER (2,147.483648 x 1e6), up to the 1e12 bound, at the six-decimal limit, both sides of zero. */
export const ATTRIBUTE_NUMBER_EDGES = [
    0, -0, 1, -1, 15.6, 0.1 + 0.2, 4096, 4096.5, -4096.25, 2147.483647, 2147.483648, 2147.483649, -2147.483649,
    1e9, -1e9, 1e9 + 0.123456, 123456789.123456, 1234.567891, 0.000001, -0.000001, 0.0000004, 0.0000006,
    -0.0000006, 1.0000005, 2.5e-7, 999999.999999, 999999.9999995, 9007199254.74099, 1e11 + 0.5, 999999999999,
    -999999999999, 999999999999.99,
];

/**
 * `count` numbers spread over every magnitude an attribute may hold (1e-7 to
 * 1e12, both signs), with up to seven decimals: a fixed seed, so a failure
 * names the same numbers on every run.
 */
export function attributeNumberSample(count: number): number[] {
    let state = 0x5ca1;
    const next = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
    return Array.from({ length: count }, () => {
        const magnitude = 10 ** (Math.floor(next() * 19) - 7);
        const value = Math.round(next() * magnitude * 1e7) / 1e7;
        const bounded = Math.min(value, 999_999_999_999.99);
        return next() < 0.5 ? -bounded : bounded;
    });
}

/** The canonical text the provider's SQL writes for each number, in order. */
export async function canonicalTextsInSql(db: Database, values: readonly number[]): Promise<string[]> {
    const rows: Array<{ position: number; text: string }> = await db
        .select({
            position: sql<number>`CAST(entry.key AS INTEGER)`,
            text: canonicalAttributeNumberSql(sql`CAST(entry.value AS DOUBLE PRECISION)`),
        })
        .from(sql`json_each(${JSON.stringify(values)}) AS entry`);
    return [...rows].sort((left, right) => Number(left.position) - Number(right.position)).map((row) => String(row.text));
}
