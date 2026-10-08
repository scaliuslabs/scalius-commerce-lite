import { describe, expect, it } from "vitest";
import { heroImageCandidate, heroImageSizes, heroLeadCandidates, resolveHomepageHero } from "./homepage-hero";

const slide = (url: string) => ({ id: url, url, title: "Banner", heading: "", supportingText: "", buttonLabel: "", link: "", focalPoint: { x: 50, y: 50 } });

describe("resolveHomepageHero", () => {
  const media = new Map([
    ["img-a", { id: "img-a", url: "https://cdn.example/a.jpg", alt: "", width: 1300, height: 500 }],
    ["img-a-phone", { id: "img-a-phone", url: "https://cdn.example/a-phone.jpg", alt: "", width: 640, height: 300 }],
    ["img-b", { id: "img-b", url: "https://cdn.example/b.jpg", alt: "", width: 1300, height: 500 }],
  ]);
  const lookup = (id: string) => media.get(id) ?? null;

  it("draws each slide's image, words and link on computers, and its phone image on phones", () => {
    const hero = resolveHomepageHero([
      {
        image: "img-a",
        phoneImage: "img-a-phone",
        focalPoint: { x: 20, y: 30 },
        phoneFocalPoint: { x: 70, y: 40 },
        alt: "Eid sale banner",
        heading: "Eid sale",
        text: "Up to 40% off",
        buttonLabel: "Shop now",
        link: "/collections/eid",
      },
    ], lookup);
    expect(hero.desktop).toEqual([{
      id: "0-img-a",
      url: "https://cdn.example/a.jpg",
      title: "Eid sale banner",
      heading: "Eid sale",
      supportingText: "Up to 40% off",
      buttonLabel: "Shop now",
      link: "/collections/eid",
      focalPoint: { x: 20, y: 30 },
    }]);
    expect(hero.mobile).toEqual([{ ...hero.desktop[0], id: "0-img-a-phone", url: "https://cdn.example/a-phone.jpg", focalPoint: { x: 70, y: 40 } }]);
  });

  it("shows the computer image on phones when the phone image is missing or did not resolve", () => {
    const hero = resolveHomepageHero([
      { image: "img-a", focalPoint: { x: 10, y: 10 }, alt: "A", link: null },
      { image: "img-b", phoneImage: "deleted", focalPoint: { x: 50, y: 50 }, phoneFocalPoint: { x: 90, y: 20 }, alt: "B", link: "https://example.com/sale" },
    ], lookup);
    expect(hero.mobile.map((each) => [each.url, each.focalPoint])).toEqual([
      ["https://cdn.example/a.jpg", { x: 10, y: 10 }],
      ["https://cdn.example/b.jpg", { x: 90, y: 20 }],
    ]);
    // Optional words read as empty; a slide without a link is not a link.
    expect(hero.desktop[0]).toMatchObject({ heading: "", supportingText: "", buttonLabel: "", link: "" });
    expect(hero.desktop[1]!.link).toBe("https://example.com/sale");
  });

  it("leaves out a slide whose image did not resolve, on both viewports", () => {
    const hero = resolveHomepageHero([
      { image: "gone", phoneImage: "img-a-phone", focalPoint: { x: 50, y: 50 }, alt: "Gone", link: null },
      { image: "img-b", focalPoint: { x: 50, y: 50 }, alt: "B", link: null },
    ], lookup);
    expect(hero.desktop.map((each) => each.title)).toEqual(["B"]);
    expect(hero.mobile.map((each) => each.title)).toEqual(["B"]);
    expect(resolveHomepageHero([], lookup)).toEqual({ desktop: [], mobile: [] });
  });
});

describe("heroImageCandidate", () => {
  it("offers every rendition to the banner so phones fetch a phone-sized file (R3-MOB-01)", () => {
    const candidate = heroImageCandidate("https://cdn.example/media/hero.webp/1080.webp", "mobile");
    expect(candidate.srcset).toBe([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1080]
      .map((width) => `https://cdn.example/media/hero.webp/${width}.webp ${width}w`)
      .join(", "));
    // The home LCP: DPR 2.5+ phones are asked for about 2x pixels.
    expect(candidate.sizes).toBe(
      "(min-resolution: 2.5dppx) calc(66.6vw - 1.332rem), calc(100vw - 2rem)",
    );
    expect(candidate.media).toBe("(max-width: 767px)");
    expect(candidate.src).toBe("https://cdn.example/media/hero.webp/735.webp");
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
      .toBe("(min-resolution: 2.5dppx) 66.6vw, 100vw");
    expect(heroImageSizes("split", "desktop")).toBe("50vw");
    expect(heroImageSizes("split", "mobile")).toBe("100vw");
    expect(heroImageSizes("wide-editorial", "desktop")).toBe("(min-width: 97rem) 93rem, calc(100vw - 4rem)");
  });

  it("preloads nothing without banners", () => {
    expect(heroLeadCandidates({ desktop: [], mobile: [] }, "contained-banners")).toEqual([]);
    expect(heroLeadCandidates({ desktop: [], mobile: [] }, "full-bleed")).toEqual([]);
  });
});
