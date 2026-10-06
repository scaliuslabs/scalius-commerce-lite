import { commerceCalendarDayBounds } from "@scalius/shared/commerce-time";

/** A YYYY-MM-DD filter day's first or last instant in the store's zone; undefined when not a real day. */
export function parseStoreDateOnlyBoundary(
    value: string | undefined,
    boundary: "start" | "end",
    timeZone: string,
): Date | undefined {
    if (!value) return undefined;
    try {
        const bounds = commerceCalendarDayBounds(timeZone, value);
        return new Date(
            (boundary === "start" ? bounds.start * 1000 : bounds.end * 1000 + 999),
        );
    } catch {
        return undefined;
    }
}
