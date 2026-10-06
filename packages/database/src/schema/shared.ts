// src/db/schema/shared.ts
// Shared SQL helpers used across multiple schema files.

import { sql, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";

/**
 * Unix-epoch seconds via SQLite's strftime.
 * Use as `.default(UNIX_NOW)` on integer timestamp columns
 * so that DEFAULT values are stored as seconds-since-epoch
 * (matching Drizzle's `{ mode: "timestamp" }` expectation).
 *
 * Replaces the old `sql\`CURRENT_TIMESTAMP\`` which stored an
 * ISO-8601 string into an integer column.
 */
export const UNIX_NOW = sql`(cast(strftime('%s','now') as int))`;

/**
 * A NOT NULL contact phone column (`customers.phone`, `customer_history.phone`,
 * `orders.customer_phone`). A contact without a phone (a digital or service
 * order, migration 0117) is stored as '' and read back as null, so the
 * sentinel never leaves storage. It is `NO_PHONE` in
 * @scalius/shared/customer-auth-policy, and this mapping is that module's
 * `storedPhone` / `phoneOrNull` (pinned by a test there).
 */
export const contactPhone = customType<{ data: string | null; driverData: string }>({
    dataType() {
        return "text";
    },
    toDriver(value) {
        return value?.trim() || "";
    },
    fromDriver(value) {
        return value?.trim() || null;
    },
});

/**
 * A contact phone column read in raw SQL: the phone, or NULL when there is
 * none (the SQL side of `contactPhone`'s read mapping). Use it wherever SQL
 * groups, counts or matches by phone, so '' is never one shared "phone".
 */
export function contactPhoneSql(column: SQL | SQL.Aliased | { getSQL(): SQL }): SQL {
    return sql`NULLIF(${column}, '')`;
}
