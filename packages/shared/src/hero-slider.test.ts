import { describe, expect, it } from "vitest";
import {
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  HERO_SLIDE_PRESENTATION,
  getHeroSlideObjectPosition,
} from "./hero-slider";

describe("hero slide presentation", () => {
  it("keeps desktop and mobile source dimensions explicit", () => {
    expect(HERO_SLIDE_PRESENTATION).toEqual({
      desktop: { width: 1_300, height: 500 },
      mobile: { width: 640, height: 300 },
    });
  });

  it("projects a focal point to CSS object-position, centred by default", () => {
    expect(getHeroSlideObjectPosition({ x: 12.5, y: 80 })).toBe("12.5% 80%");
    expect(getHeroSlideObjectPosition(HERO_SLIDE_DEFAULT_FOCAL_POINT)).toBe("50% 50%");
  });
});
