// src/db/schema/shared.ts
// Shared SQL helpers used across multiple schema files.

import { sql } from "drizzle-orm";

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
