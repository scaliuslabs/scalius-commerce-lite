import { describe, expect, it } from "vitest";
import {
  HEADER_COMPACT_ENTER_PX,
  HEADER_COMPACT_EXIT_PX,
  shouldUseCompactHeader,
} from "./header-scroll-state";

describe("header scroll state", () => {
  it("ignores tiny scroll movements at the top of the page", () => {
    expect(shouldUseCompactHeader(1, false)).toBe(false);
    expect(shouldUseCompactHeader(HEADER_COMPACT_ENTER_PX - 1, false)).toBe(
      false,
    );
  });

  it("keeps the compact state through layout movement caused by collapsing", () => {
    expect(shouldUseCompactHeader(HEADER_COMPACT_ENTER_PX, false)).toBe(true);
    expect(shouldUseCompactHeader(34, true)).toBe(true);
  });

  it("expands only after the customer returns near the page top", () => {
    expect(shouldUseCompactHeader(HEADER_COMPACT_EXIT_PX + 1, true)).toBe(true);
    expect(shouldUseCompactHeader(HEADER_COMPACT_EXIT_PX, true)).toBe(false);
  });
});
