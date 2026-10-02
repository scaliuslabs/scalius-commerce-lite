import { describe, expect, it } from "vitest";
import { homepageLandingPath } from "./homepage-landing";

const productHome = { kind: "product", productId: "product_1" } as const;
const homeProduct = { id: "product_1", slug: "cx-h-product-1" };

describe("product homepage destination", () => {
  it("opens the theme's public product on its own route", () => {
    expect(homepageLandingPath(productHome, homeProduct)).toBe("/products/cx-h-product-1");
  });

  it("renders the sections in sections mode, and while the product is not public", () => {
    expect(homepageLandingPath({ kind: "sections" }, homeProduct)).toBeNull();
    expect(homepageLandingPath(productHome, null)).toBeNull();
    expect(homepageLandingPath(productHome, undefined)).toBeNull();
  });

  it("never opens a product other than the one the theme names", () => {
    expect(homepageLandingPath({ kind: "product", productId: "product_2" }, homeProduct)).toBeNull();
  });

  it("rejects dot segments that URL normalization could send back to the homepage", () => {
    for (const slug of ["", ".", ".."]) {
      expect(homepageLandingPath(productHome, { id: "product_1", slug })).toBeNull();
    }
  });

  it("encodes the slug as one product-route segment, never a destination URL", () => {
    expect(homepageLandingPath(productHome, { id: "product_1", slug: "কাপড়" }))
      .toBe(`/products/${encodeURIComponent("কাপড়")}`);
    expect(homepageLandingPath(productHome, { id: "product_1", slug: "//elsewhere.test/?next=/" }))
      .toBe("/products/%2F%2Felsewhere.test%2F%3Fnext%3D%2F");
  });
});
