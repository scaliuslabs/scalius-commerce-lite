import { describe, expect, it } from "vitest";
import { resolveHomepageHero } from "./homepage-hero";

const slide = (url: string) => ({ url, link: "", focalPoint: { x: 50, y: 50 } });

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
