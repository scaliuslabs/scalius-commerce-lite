import { describe, expect, it } from "vitest";
import { parseStoreDateOnlyBoundary } from "./order-date-filter";

describe("order date filters", () => {
    it("converts Bangladesh calendar days to exact UTC bounds", () => {
        expect(
            parseStoreDateOnlyBoundary("2026-06-19", "start", "Asia/Dhaka")?.toISOString(),
        ).toBe("2026-06-18T18:00:00.000Z");
        expect(
            parseStoreDateOnlyBoundary("2026-06-19", "end", "Asia/Dhaka")?.toISOString(),
        ).toBe("2026-06-19T17:59:59.999Z");
    });

    it("follows daylight saving time in the store's zone", () => {
        // New York springs forward on 2026-03-08: that day is 23 hours long.
        expect(parseStoreDateOnlyBoundary("2026-03-08", "start", "America/New_York")?.toISOString())
            .toBe("2026-03-08T05:00:00.000Z");
        expect(parseStoreDateOnlyBoundary("2026-03-08", "end", "America/New_York")?.toISOString())
            .toBe("2026-03-09T03:59:59.999Z");
    });

    it("rejects invalid or non-date-only strings", () => {
        expect(parseStoreDateOnlyBoundary("2026-02-31", "start", "Asia/Dhaka")).toBeUndefined();
        expect(
            parseStoreDateOnlyBoundary("2026-06-19T00:00:00.000Z", "end", "Asia/Dhaka"),
        ).toBeUndefined();
    });
});
