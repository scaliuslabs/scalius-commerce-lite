import { describe, expect, it } from "vitest";
import {
  HERO_SLIDE_LIMIT,
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  HERO_SLIDE_PRESENTATION,
  getHeroSlideObjectPosition,
  normalizeHeroSlideImageUrl,
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
          heading: "",
          buttonLabel: "",
          link: "/collections/new",
          focalPoint: HERO_SLIDE_DEFAULT_FOCAL_POINT,
        },
      ],
    });
  });

  it("keeps alt text apart from the optional heading and button drawn over the banner", () => {
    const result = validateAndNormalizeHeroSlides([{
      ...baseSlide,
      title: "Eid offer: 20% off panjabi",
      heading: "  ঈদ অফার  ",
      buttonLabel: " Shop now ",
    }]);
    expect(result).toMatchObject({
      ok: true,
      slides: [{ title: "Eid offer: 20% off panjabi", heading: "ঈদ অফার", buttonLabel: "Shop now" }],
    });
    expect(validateAndNormalizeHeroSlides([{ ...baseSlide, buttonLabel: "x".repeat(41) }])).toMatchObject({ ok: false });
  });

  it("normalizes a merchant focal point and projects it to CSS object-position", () => {
    const result = validateAndNormalizeHeroSlides([{
      ...baseSlide,
      focalPoint: { x: 24.1234, y: 81.9876 },
    }]);
    expect(result).toMatchObject({
      ok: true,
      slides: [{ focalPoint: { x: 24.12, y: 81.99 } }],
    });
    if (!result.ok) throw new Error("Expected a valid focal point");
    const focalPoint = result.slides[0]?.focalPoint;
    if (!focalPoint) throw new Error("Expected one normalized slide");
    expect(getHeroSlideObjectPosition(focalPoint)).toBe("24.12% 81.99%");
  });

  it("rejects focal points outside the source image", () => {
    expect(validateAndNormalizeHeroSlides([{
      ...baseSlide,
      focalPoint: { x: -1, y: 50 },
    }])).toEqual({
      ok: false,
      errors: ["Slide 1 focal point must use horizontal and vertical percentages from 0 to 100."],
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

  it("accepts plain HTTP images only from loopback hosts (local development)", () => {
    expect(normalizeHeroSlideImageUrl("http://localhost:8787/media/a.png")).toBe("http://localhost:8787/media/a.png");
    expect(normalizeHeroSlideImageUrl("http://127.0.0.1/a.png")).toBe("http://127.0.0.1/a.png");
    expect(normalizeHeroSlideImageUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(normalizeHeroSlideImageUrl("http://cdn.example.com/a.png")).toBeUndefined();
    expect(normalizeHeroSlideImageUrl("http://localhost.evil.com/a.png")).toBeUndefined();
    expect(normalizeHeroSlideImageUrl("http://user:pass@localhost/a.png")).toBeUndefined();
    expect(normalizeHeroSlideImageUrl("ftp://localhost/a.png")).toBeUndefined();
    expect(
      validateAndNormalizeHeroSlides([{ ...baseSlide, url: "http://localhost:8787/media/a.png" }]),
    ).toMatchObject({ ok: true });
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
