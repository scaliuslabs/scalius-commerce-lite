import { describe, expect, it } from "vitest";
import { heroImageCandidate, heroImageSizes, heroLeadCandidates, resolveHomepageHero } from "./homepage-hero";

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
    expect(candidate.srcset).toBe([160, 240, 320, 400, 480, 640, 960, 1080]
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

describe("heroLeadCandidates", () => {
  const desktop = [slide("https://cdn.example/media/d.webp/1080.webp")];
  const mobile = [slide("https://cdn.example/media/m.webp/1080.webp")];

  it("preloads each viewport's first banner at the size its layout paints", () => {
    const contained = heroLeadCandidates({ desktop, mobile }, "contained-banners");
    expect(contained.map((candidate) => candidate.media)).toEqual(["(max-width: 767px)", "(min-width: 768px)"]);
    expect(contained[1]!.sizes).toBe(heroImageCandidate(desktop[0]!.url, "desktop").sizes);
    expect(heroLeadCandidates({ desktop, mobile }, "full-bleed")[1]!.sizes)
      .toBe("(min-resolution: 2.5dppx) calc((100vw) * 0.667), 100vw");
    expect(heroImageSizes("split", "desktop")).toBe("50vw");
    expect(heroImageSizes("split", "mobile")).toBe("100vw");
  });

  it("offers story cards one candidate for every screen", () => {
    const [candidate, ...rest] = heroLeadCandidates({ desktop, mobile }, "story-cards");
    expect(rest).toEqual([]);
    expect(candidate!.media).toBe("all");
    expect(candidate!.srcset).toContain("media/d.webp");
  });

  it("preloads nothing without banners", () => {
    expect(heroLeadCandidates({ desktop: [], mobile: [] }, "story-cards")).toEqual([]);
    expect(heroLeadCandidates({ desktop: [], mobile: [] }, "full-bleed")).toEqual([]);
  });
});
