import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "@/lib/test-source-paths";
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

  it("cross-fades desktop center states without a blank midpoint", () => {
    const source = readFileSync(
      storefrontSourcePath("components", "header", "HeaderLayout.astro"),
      "utf8",
    );

    expect(source).toContain("header-expanded-center");
    expect(source).toContain("header-compact-center");
    expect(source).toContain("transition-delay: 0ms, 0ms, 0ms");
    expect(source).toContain("transition-delay: 0ms, 0ms, 180ms");
    expect(source).toContain("transition-[max-height,transform]");
    expect(source).not.toContain(
      "group-[.is-scrolled]/header:opacity-100 group-[.is-scrolled]/header:scale-100",
    );
  });

  it("tracks the real animated header height instead of applying a delayed jump", () => {
    const source = readFileSync(
      storefrontSourcePath("components", "header", "HeaderLayout.astro"),
      "utf8",
    );

    expect(source).toContain("new ResizeObserver(updateHeaderHeight)");
    expect(source).toContain("headerResizeObserver.observe(header)");
    expect(source).not.toContain("setTimeout(updateHeaderHeight, 350)");
  });
});
