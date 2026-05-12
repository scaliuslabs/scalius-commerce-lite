const UNIX_SECONDS_UPPER_BOUND = 10_000_000_000;

const isValidDate = (date: Date): boolean => !Number.isNaN(date.getTime());

export function toIsoTimestamp(timestamp: unknown): string | null {
  if (timestamp === null || timestamp === undefined) return null;

  if (timestamp instanceof Date) {
    return isValidDate(timestamp) ? timestamp.toISOString() : null;
  }

  if (typeof timestamp === "string") {
    const trimmed = timestamp.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return toIsoTimestamp(numeric);
    }

    const parsed = new Date(trimmed);
    return isValidDate(parsed) ? parsed.toISOString() : null;
  }

  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  const date = new Date(
    timestamp < UNIX_SECONDS_UPPER_BOUND ? timestamp * 1000 : timestamp,
  );
  return isValidDate(date) ? date.toISOString() : null;
}
