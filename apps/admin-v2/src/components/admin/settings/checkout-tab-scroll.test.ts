import { describe, expect, it } from "vitest";
import { getNearestTabScrollLeft } from "./CheckoutSettingsPage";

describe("checkout settings tab visibility", () => {
  const strip = {
    clientWidth: 360,
    scrollWidth: 798,
  };

  it("preserves the strip when the active tab is already visible", () => {
    expect(
      getNearestTabScrollLeft({
        ...strip,
        scrollLeft: 143,
        tabOffsetLeft: 266,
        tabOffsetWidth: 96,
      }),
    ).toBe(143);
  });

  it("moves only enough to reveal a clipped tab", () => {
    expect(
      getNearestTabScrollLeft({
        ...strip,
        scrollLeft: 0,
        tabOffsetLeft: 266,
        tabOffsetWidth: 96,
      }),
    ).toBe(10);
  });

  it("clamps the first and final tabs to the strip boundaries", () => {
    expect(
      getNearestTabScrollLeft({
        ...strip,
        scrollLeft: 438,
        tabOffsetLeft: 0,
        tabOffsetWidth: 118,
      }),
    ).toBe(0);
    expect(
      getNearestTabScrollLeft({
        ...strip,
        scrollLeft: 0,
        tabOffsetLeft: 648,
        tabOffsetWidth: 150,
      }),
    ).toBe(438);
  });
});
