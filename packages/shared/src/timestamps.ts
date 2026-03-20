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
