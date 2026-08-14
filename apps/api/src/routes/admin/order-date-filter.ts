import { commerceCalendarDayBounds } from "@scalius/shared/commerce-time";

export function parseBangladeshDateOnlyBoundary(
    value: string | undefined,
    boundary: "start" | "end",
): Date | undefined {
    if (!value) return undefined;
    try {
        const bounds = commerceCalendarDayBounds(value);
        return new Date(
            (boundary === "start" ? bounds.start * 1000 : bounds.end * 1000 + 999),
        );
    } catch {
        return undefined;
    }
}
