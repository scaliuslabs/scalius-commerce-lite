import { sql } from "drizzle-orm";

/**
 * Generates a readable order ID in the format A39K02 (6 characters, uppercase letters and numbers)
 */
export function generateOrderId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Returns the current timestamp in SQLite format (Unix timestamp in seconds)
 */
export function getCurrentTimestamp() {
  return sql`(cast(strftime('%s','now') as int))`;
}
