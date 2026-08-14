import { describe, expect, it } from "vitest";

import { formatDate, formatDateShort, formatDateVerbose } from "./timestamps";

describe("merchant timestamp formatting", () => {
  const boundary = "2026-08-13T20:30:00.000Z";

  it("formats absolute instants on the Bangladesh merchant calendar", () => {
    expect(formatDateShort(boundary)).toBe("Aug 14, 2026");
    expect(formatDate(boundary)).toContain("Aug 14, 2026");
    expect(formatDateVerbose(boundary)).toContain("August 14, 2026");
  });
});
