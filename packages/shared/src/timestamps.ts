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

/**
 * Formats a date for display (date-only, no time).
 * Output: "Mar 22, 2026"
 */
export function formatDateShort(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) return "N/A";

  if (typeof date === "number" || typeof date === "string") {
    date = unixToDate(date);
  }

  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "N/A";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Formats a date as relative time for recent dates, absolute for older ones.
 * <1min: "Just now", <1h: "5m ago", <24h: "3h ago",
 * <7d: "Mon, 3:45 PM", older: "Mar 22, 3:45 PM" (adds year if different).
 */
export function formatRelativeDate(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) return "\u2014";

  if (typeof date === "number" || typeof date === "string") {
    date = unixToDate(date);
  }

  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "\u2014";
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 1 && diffMs >= 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return diffMinutes < 1 ? "Just now" : `${diffMinutes}m ago`;
    }
    return `${diffHours}h ago`;
  }

  if (diffDays < 7 && diffDays >= 0) {
    return date.toLocaleString("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: now.getFullYear() !== date.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Formats a date in verbose form for tooltips.
 * Output: "Monday, March 22, 2026, 3:45:30 PM EST"
 */
export function formatDateVerbose(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) return "\u2014";

  if (typeof date === "number" || typeof date === "string") {
    date = unixToDate(date);
  }

  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "\u2014";
  }

  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}
