import { describe, expect, it } from "vitest";
import {
  HERO_SLIDE_LIMIT,
  HERO_SLIDE_PRESENTATION,
  parseStoredHeroSlides,
  validateAndNormalizeHeroSlides,
} from "./hero-slider";

const baseSlide = {
  id: "img_1",
  url: "https://cdn.example.com/hero image.jpg",
  title: "  New arrivals  ",
  link: " collections/new ",
};

describe("hero slider document", () => {
  it("keeps desktop and mobile source dimensions explicit", () => {
    expect(HERO_SLIDE_PRESENTATION).toEqual({
      desktop: { width: 1_300, height: 500 },
      mobile: { width: 640, height: 300 },
    });
  });

  it("canonicalizes safe images and destinations", () => {
    expect(validateAndNormalizeHeroSlides([baseSlide])).toEqual({
      ok: true,
      slides: [
        {
          id: "img_1",
          url: "https://cdn.example.com/hero%20image.jpg",
          title: "New arrivals",
          link: "/collections/new",
        },
      ],
    });
  });

  it.each(["", "#", null, undefined])(
    "treats %j as an intentionally unlinked slide",
    (link) => {
      const result = validateAndNormalizeHeroSlides([{ ...baseSlide, link }]);
      expect(result).toMatchObject({
        ok: true,
        slides: [{ link: "" }],
      });
    },
  );

  it("rejects unsafe links, image credentials, duplicate IDs, and oversized documents", () => {
    expect(
      validateAndNormalizeHeroSlides([
        { ...baseSlide, link: "javascript:alert(1)" },
        {
          ...baseSlide,
          url: "https://user:pass@cdn.example.com/hero.jpg",
          link: "/safe",
        },
      ]),
    ).toMatchObject({ ok: false });

    expect(
      validateAndNormalizeHeroSlides(
        Array.from({ length: HERO_SLIDE_LIMIT + 1 }, (_, index) => ({
          ...baseSlide,
          id: `img_${index}`,
        })),
      ),
    ).toEqual({ ok: false, errors: ["Use at most 12 hero slides."] });
  });

  it("fails closed for malformed or unsafe persisted documents", () => {
    expect(parseStoredHeroSlides("not-json")).toEqual([]);
    expect(
      parseStoredHeroSlides(
        JSON.stringify([{ ...baseSlide, link: "data:text/html,bad" }]),
      ),
    ).toEqual([]);
  });
});
