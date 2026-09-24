import { describe, expect, it } from "vitest";
import { heroImageCandidate, resolveHomepageHero } from "./homepage-hero";

const slide = (url: string) => ({ id: url, url, title: "Banner", heading: "", buttonLabel: "", link: "", focalPoint: { x: 50, y: 50 } });

describe("resolveHomepageHero", () => {
  it("shows desktop banners on phones when no phone banners exist", () => {
    const desktop = [slide("https://cdn.example/a.jpg")];
    expect(resolveHomepageHero({ desktop: { id: "d", type: "desktop", images: desktop }, mobile: null }))
      .toEqual({ desktop, mobile: desktop });
  });

  it("keeps dedicated phone banners", () => {
    const desktop = [slide("https://cdn.example/a.jpg")];
    const mobile = [slide("https://cdn.example/m.jpg")];
    expect(resolveHomepageHero({
      desktop: { id: "d", type: "desktop", images: desktop },
      mobile: { id: "m", type: "mobile", images: mobile },
    })).toEqual({ desktop, mobile });
  });

  it("is empty without banners", () => {
    expect(resolveHomepageHero(null)).toEqual({ desktop: [], mobile: [] });
  });
});

describe("heroImageCandidate", () => {
  it("offers every rendition to the banner so phones fetch a phone-sized file (R3-MOB-01)", () => {
    const candidate = heroImageCandidate("https://cdn.example/media/hero.webp/1080.webp", "mobile");
    expect(candidate.srcset).toBe([160, 320, 480, 640, 960, 1080]
      .map((width) => `https://cdn.example/media/hero.webp/${width}.webp ${width}w`)
      .join(", "));
    // The home LCP: DPR 2.5+ phones are asked for about 2x pixels.
    expect(candidate.sizes).toBe(
      "(min-resolution: 2.5dppx) calc((100vw - 2rem) * 0.667), calc(100vw - 2rem)",
    );
    expect(candidate.media).toBe("(max-width: 767px)");
    expect(candidate.src).toBe("https://cdn.example/media/hero.webp/640.webp");
  });

  it("falls back to the single original when an image has no renditions", () => {
    const candidate = heroImageCandidate("https://cdn.example/a.jpg", "desktop");
    expect(candidate.srcset).toBeUndefined();
    expect(candidate.src).toBe("https://cdn.example/a.jpg");
    expect(candidate.media).toBe("(min-width: 768px)");
  });
});
