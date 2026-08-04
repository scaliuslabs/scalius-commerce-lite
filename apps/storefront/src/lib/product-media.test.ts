import { describe, expect, it } from "vitest";
import { rebaseProductImageTransform } from "./product-media";

describe("product media transform origin", () => {
  it("serves an absolute CDN transform through the storefront connection", () => {
    expect(
      rebaseProductImageTransform(
        "https://cloud.example.com/cdn-cgi/image/width=540,quality=78/media/product.webp",
      ),
    ).toBe(
      "/cdn-cgi/image/width=540,quality=78/https://cloud.example.com/media/product.webp",
    );
  });

  it("preserves source queries while leaving non-transform URLs unchanged", () => {
    expect(
      rebaseProductImageTransform(
        "https://cloud.example.com/cdn-cgi/image/width=320/media/product.webp?v=2",
      ),
    ).toBe(
      "/cdn-cgi/image/width=320/https://cloud.example.com/media/product.webp?v=2",
    );
    expect(rebaseProductImageTransform("/images/product.webp")).toBe(
      "/images/product.webp",
    );
    expect(
      rebaseProductImageTransform("https://images.example.com/product.webp"),
    ).toBe("https://images.example.com/product.webp");
  });
});
