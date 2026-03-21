// src/timestamps.ts
// Timestamp utilities for working with Unix epoch seconds.
// The database stores timestamps as integer columns containing seconds since epoch.
// NOTE: For Drizzle schema defaults, use UNIX_NOW from @scalius/database/schema (shared.ts).
// These utilities are for service/application-layer timestamp operations.

/** Convert Unix epoch seconds to ISO 8601 string for API responses */
export function toISOString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Convert Unix epoch seconds to Date object */
export function fromUnixSeconds(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

/** Get current Unix epoch seconds (for non-Drizzle contexts) */
export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Converts a Unix timestamp (in seconds) to a JavaScript Date object.
 * Handles both number and string inputs, and passes through Date objects.
 * Auto-detects whether the value is in seconds (10-digit) or milliseconds (13-digit).
 */
export function unixToDate(
  timestamp: number | string | Date | null | undefined,
): Date | null {
  if (timestamp === null || timestamp === undefined) return null;

  // If already a Date object, return it
  if (timestamp instanceof Date) return timestamp;

  const numTimestamp =
    typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;

  // Check if the timestamp is in seconds (Unix timestamp) or milliseconds (JS timestamp)
  // Unix timestamps are typically 10 digits, JS timestamps are 13 digits
  const multiplier = numTimestamp < 10000000000 ? 1000 : 1;

  try {
    const date = new Date(numTimestamp * multiplier);
    return isNaN(date.getTime()) ? null : date;
  } catch (error: unknown) {
    console.error("Error converting timestamp to date:", error);
    return null;
  }
}

/**
 * Formats a date for display.
 * Handles null dates, invalid dates, and Unix timestamps.
 */
export function formatDate(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) return "N/A";

  // If date is a timestamp (number or string), convert it to a Date object
  if (typeof date === "number" || typeof date === "string") {
    date = unixToDate(date);
  }

  // Check if date is valid
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "Invalid date";
  }

  try {
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch (error: unknown) {
    console.error("Error formatting date:", error);
    return "Invalid date";
  }
}
