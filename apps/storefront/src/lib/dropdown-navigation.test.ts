import { describe, expect, it } from "vitest";

import {
  nextDropdownOptionIndex,
  resolveDropdownLayout,
  resolveDropdownScrollTop,
} from "./dropdown-navigation";

describe("adaptive dropdown navigation", () => {
  it("opens below when there is room and above near the viewport edge", () => {
    expect(resolveDropdownLayout(100, 136, 800)).toEqual({
      placement: "below",
      maxHeight: 288,
    });
    expect(resolveDropdownLayout(700, 736, 800)).toEqual({
      placement: "above",
      maxHeight: 288,
    });
  });

  it("keeps a usable bounded menu in a compact viewport", () => {
    expect(resolveDropdownLayout(110, 146, 260)).toEqual({
      placement: "below",
      maxHeight: 120,
    });
  });

  it("supports wrapping arrow, home, and end navigation", () => {
    expect(nextDropdownOptionIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(nextDropdownOptionIndex(2, 3, "ArrowDown")).toBe(0);
    expect(nextDropdownOptionIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextDropdownOptionIndex(1, 3, "Home")).toBe(0);
    expect(nextDropdownOptionIndex(1, 3, "End")).toBe(2);
  });

  it("scrolls only the list viewport to reveal the active option", () => {
    expect(resolveDropdownScrollTop(200, 100, 300, 80, 112)).toBe(180);
    expect(resolveDropdownScrollTop(200, 100, 300, 286, 322)).toBe(222);
    expect(resolveDropdownScrollTop(200, 100, 300, 140, 176)).toBe(200);
    expect(resolveDropdownScrollTop(5, 100, 300, 80, 112)).toBe(0);
  });
});
