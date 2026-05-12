import { describe, expect, it } from "vitest";
import { toIsoTimestamp } from "../../../apps/api/src/utils/timestamps";

describe("API timestamp formatting", () => {
  it("keeps Drizzle timestamp Date objects as-is", () => {
    expect(toIsoTimestamp(new Date("2026-05-12T08:00:00.000Z"))).toBe(
      "2026-05-12T08:00:00.000Z",
    );
  });

  it("converts unix seconds without double-multiplying", () => {
    expect(toIsoTimestamp(1_778_576_000)).toBe("2026-05-12T08:53:20.000Z");
    expect(toIsoTimestamp("1778576000")).toBe("2026-05-12T08:53:20.000Z");
  });

  it("accepts millisecond timestamps from external callers", () => {
    expect(toIsoTimestamp(1_778_576_000_000)).toBe(
      "2026-05-12T08:53:20.000Z",
    );
  });

  it("returns null for empty or invalid values", () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp("")).toBeNull();
    expect(toIsoTimestamp(0)).toBeNull();
    expect(toIsoTimestamp("not-a-date")).toBeNull();
    expect(toIsoTimestamp(new Date("not-a-date"))).toBeNull();
  });
});
