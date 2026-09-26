import { describe, expect, it } from "vitest";
import { homepageLandingPath } from "./homepage-landing";
import type { HomepageData } from "./api/storefront";

const presentation: HomepageData["presentation"] = {
  categoryRail: { enabled: false, title: "", categories: [] },
  trustStrip: { enabled: false },
  homeMode: "landing",
  landingProduct: { id: "product_1", slug: "cx-h-product-1" },
};

describe("landing homepage destination", () => {
  it("opens the resolved public product route", () => {
    expect(homepageLandingPath(presentation)).toBe("/products/cx-h-product-1");
  });

  it("keeps catalog mode and missing or unavailable products on the homepage", () => {
    expect(homepageLandingPath({ ...presentation, homeMode: "catalog" })).toBeNull();
    expect(homepageLandingPath({ ...presentation, landingProduct: null })).toBeNull();
    expect(homepageLandingPath({ ...presentation, homeMode: undefined, landingProduct: undefined })).toBeNull();
  });

  it("rejects dot segments that URL normalization could send back to the homepage", () => {
    for (const slug of ["", ".", ".."]) {
      expect(homepageLandingPath({ ...presentation, landingProduct: { id: "product_1", slug } })).toBeNull();
    }
  });

  it("encodes the slug as one product-route segment, never a destination URL", () => {
    expect(homepageLandingPath({ ...presentation, landingProduct: { id: "product_1", slug: "কাপড়" } }))
      .toBe(`/products/${encodeURIComponent("কাপড়")}`);
    expect(homepageLandingPath({ ...presentation, landingProduct: { id: "product_1", slug: "//elsewhere.test/?next=/" } }))
      .toBe("/products/%2F%2Felsewhere.test%2F%3Fnext%3D%2F");
  });
});
