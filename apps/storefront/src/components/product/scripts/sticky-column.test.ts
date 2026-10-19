import { describe, expect, it } from "vitest";
import { nextStickyShift } from "./sticky-column";

describe("sticky column taller than the window", () => {
  // A 1,400px buy column pinned 80px below the top of a 900px window.
  const tall = { offset: 80, height: 1400 };
  const lowest = 900 - 16 - 80 - 1400; // -596: its end 16px above the window's bottom

  it("scrolls with the page until its end is in view, then stays", () => {
    let shift = 0;
    shift = nextStickyShift({ ...tall, shift }, 300, 900);
    expect(shift).toBe(-300);
    shift = nextStickyShift({ ...tall, shift }, 500, 900);
    expect(shift).toBe(lowest);
    shift = nextStickyShift({ ...tall, shift }, 2000, 900);
    expect(shift).toBe(lowest);
  });

  it("scrolls back with the page on the way up until its top is pinned again", () => {
    let shift = lowest;
    shift = nextStickyShift({ ...tall, shift }, -200, 900);
    expect(shift).toBe(lowest + 200);
    shift = nextStickyShift({ ...tall, shift }, -5000, 900);
    expect(shift).toBe(0);
  });

  it("leaves a column that fits the window pinned at its top", () => {
    expect(nextStickyShift({ offset: 80, height: 600, shift: 0 }, 400, 900)).toBe(0);
    // A window that grows back past the column releases any shift.
    expect(nextStickyShift({ offset: 80, height: 600, shift: -120 }, 0, 900)).toBe(0);
  });
});
