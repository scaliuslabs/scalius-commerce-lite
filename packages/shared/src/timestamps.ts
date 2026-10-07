// src/timestamps.ts
// Timestamp utilities for working with Unix epoch seconds.
// The database stores timestamps as integer columns containing seconds since epoch.
// NOTE: For Drizzle schema defaults, use UNIX_NOW from @scalius/database/schema (shared.ts).
// These utilities are for service/application-layer timestamp operations.

/** Convert Unix epoch seconds to ISO 8601 string for API responses */
export function toISOString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Converts a timestamp to a JavaScript Date object.
 * Handles Unix seconds, milliseconds, ISO strings, and Date objects.
 * Auto-detects whether numeric values are seconds (10-digit) or milliseconds (13-digit).
 */
export function unixToDate(
  timestamp: number | string | Date | null | undefined,
): Date | null {
  if (timestamp === null || timestamp === undefined) return null;
  if (timestamp instanceof Date) return timestamp;

  if (typeof timestamp === "string") {
    // Try as numeric string first (Unix timestamp)
    const num = Number(timestamp);
    if (!isNaN(num) && timestamp.trim() !== "") {
      const multiplier = num < 10000000000 ? 1000 : 1;
      const date = new Date(num * multiplier);
      return isNaN(date.getTime()) ? null : date;
    }
    // Otherwise treat as ISO / date string
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? null : date;
  }

  // Numeric timestamp — detect seconds vs milliseconds
  const multiplier = timestamp < 10000000000 ? 1000 : 1;
  const date = new Date(timestamp * multiplier);
  return isNaN(date.getTime()) ? null : date;
}
