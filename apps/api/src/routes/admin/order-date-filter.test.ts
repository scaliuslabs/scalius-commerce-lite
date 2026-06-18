import { describe, expect, it } from "vitest";
import { parseBangladeshDateOnlyBoundary } from "./order-date-filter";

describe("order date filters", () => {
    it("converts Bangladesh calendar days to exact UTC bounds", () => {
        expect(
            parseBangladeshDateOnlyBoundary("2026-06-19", "start")?.toISOString(),
        ).toBe("2026-06-18T18:00:00.000Z");
        expect(
            parseBangladeshDateOnlyBoundary("2026-06-19", "end")?.toISOString(),
        ).toBe("2026-06-19T17:59:59.999Z");
    });

    it("rejects invalid or non-date-only strings", () => {
        expect(parseBangladeshDateOnlyBoundary("2026-02-31", "start")).toBeUndefined();
        expect(
            parseBangladeshDateOnlyBoundary("2026-06-19T00:00:00.000Z", "end"),
        ).toBeUndefined();
    });
});
