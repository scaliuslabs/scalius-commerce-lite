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

  it("hands desktop center states off without a blank midpoint", () => {
    const source = readFileSync(
      storefrontSourcePath("components", "header", "HeaderLayout.astro"),
      "utf8",
    );

    expect(source).toContain("header-expanded-center");
    expect(source).toContain("header-compact-center");
    expect(source).toContain("header-full-nav-row");
    expect(source.match(/opacity 160ms linear 40ms/g)).toHaveLength(4);
    expect(source.match(/opacity 160ms linear,/g)).toHaveLength(4);
    expect(source.match(/visibility 0s linear 40ms/g)).toHaveLength(4);
    expect(source.match(/visibility 0s linear 160ms/g)).toHaveLength(4);
    expect(source).not.toContain("opacity 120ms ease 200ms");
    expect(source).not.toContain("visibility 0s linear 200ms");
    expect(source).not.toContain("transition-delay: 80ms, 80ms, 0ms");
    expect(source).not.toContain("transition-delay: 40ms, 40ms, 0ms");
    expect(source).toContain("#main-header.is-scrolled .header-full-nav-row");
    expect(source).toContain("transition-[max-height,transform]");
    expect(source).not.toContain(
      "group-[.is-scrolled]/header:opacity-100 group-[.is-scrolled]/header:scale-100",
    );

    const navSource = readFileSync(
      storefrontSourcePath("components", "header", "DesktopNav.astro"),
      "utf8",
    );
    expect(navSource).toContain("relative flex shrink-0 items-center");
    expect(navSource).toContain("if (!desktopNavMedia.matches) return");
    expect(navSource).toContain("nav.dataset.dynamicNavReady");
    expect(
      navSource.match(/requestAnimationFrame\(this\.updateNav\)/g),
    ).toHaveLength(2);
    expect(navSource).not.toContain("new MutationObserver");
    expect(navSource).not.toContain(
      'window.dispatchEvent(new Event("resize"))',
    );
  });

  it("morphs desktop secondary actions without a display-driven layout jump", () => {
    const source = readFileSync(
      storefrontSourcePath("components", "header", "HeaderLayout.astro"),
      "utf8",
    );

    expect(source).toContain("header-action-morph");
    expect(source).toContain("header-expanded-actions");
    expect(source).toContain("header-scroll-search");
    expect(source).toContain("--header-actions-expanded-lg");
    expect(source).toContain("#main-header.is-scrolled .header-action-morph");
    expect(source).not.toContain("lg:group-[.is-scrolled]/header:hidden");
    expect(source).not.toContain("lg:group-[.is-scrolled]/header:flex");
  });

  it("tracks the real animated header height instead of applying a delayed jump", () => {
    const source = readFileSync(
      storefrontSourcePath("components", "header", "HeaderLayout.astro"),
      "utf8",
    );

    expect(source).toContain("new ResizeObserver((entries) =>");
    expect(source).toContain("borderBox?.blockSize");
    expect(source).toContain("headerResizeObserver.observe(header)");
    expect(source).not.toContain(
      'window.addEventListener("resize", updateHeaderHeight)',
    );
    expect(source).not.toContain("setTimeout(updateHeaderHeight, 350)");
  });
});
