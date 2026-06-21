import { describe, expect, it } from "vitest";
import { getSortableStyle } from "./sortable-style";

describe("getSortableStyle", () => {
  it("omits empty sortable styles", () => {
    expect(getSortableStyle(null, undefined)).toBeUndefined();
    expect(getSortableStyle(null, null)).toBeUndefined();
  });

  it("returns transform and transition only when sortable state needs them", () => {
    expect(
      getSortableStyle(
        { x: 10, y: 20, scaleX: 1, scaleY: 1 },
        "transform 200ms ease",
      ),
    ).toEqual({
      transform: "translate3d(10px, 20px, 0) scaleX(1) scaleY(1)",
      transition: "transform 200ms ease",
    });
  });

  it("preserves explicit extra drag styles without forcing idle opacity", () => {
    expect(getSortableStyle(null, undefined, { opacity: 0.5 })).toEqual({
      opacity: 0.5,
      transform: undefined,
      transition: undefined,
    });
  });
});
