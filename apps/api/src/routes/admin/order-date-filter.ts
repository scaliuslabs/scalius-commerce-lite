const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const BANGLADESH_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseBangladeshDateOnlyBoundary(
    value: string | undefined,
    boundary: "start" | "end",
): Date | undefined {
    if (!value) return undefined;
    const match = DATE_ONLY_PATTERN.exec(value);
    if (!match) return undefined;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utcMidnight = Date.UTC(year, month - 1, day);
    const normalized = new Date(utcMidnight);

    if (
        normalized.getUTCFullYear() !== year ||
        normalized.getUTCMonth() !== month - 1 ||
        normalized.getUTCDate() !== day
    ) {
        return undefined;
    }

    const bangladeshDayStartUtc = utcMidnight - BANGLADESH_UTC_OFFSET_MS;
    return new Date(
        boundary === "start"
            ? bangladeshDayStartUtc
            : bangladeshDayStartUtc + DAY_MS - 1,
    );
}
