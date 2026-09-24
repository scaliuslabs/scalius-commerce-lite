import { describe, expect, it } from "vitest";
import { productCardImageSizes } from "./product-card-layout";

describe("productCardImageSizes", () => {
  it("matches the grid columns the theme renders", () => {
    expect(productCardImageSizes({ desktop: 4, mobile: 2 })).toBe(
      "(max-width: 639px) calc(50vw - 1.5rem), (max-width: 1023px) 33vw, (min-width: 1280px) min(25vw, 320px), 25vw",
    );
    expect(productCardImageSizes({ desktop: 2, mobile: 1 })).toBe(
      "(max-width: 639px) calc(100vw - 2rem), (max-width: 1023px) 50vw, (min-width: 1280px) min(50vw, 640px), 50vw",
    );
  });
});
