import { describe, expect, it } from "vitest";
import {
  getProductImageSrcSet,
  getProductImageUrl,
  hasProductImage,
  PRODUCT_IMAGE_FALLBACK,
} from "../../../apps/storefront/src/lib/product-media";

describe("storefront product media helpers", () => {
  it("uses the canonical product placeholder when no image is present", () => {
    expect(getProductImageUrl(null)).toBe(PRODUCT_IMAGE_FALLBACK);
    expect(getProductImageUrl("   ")).toBe(PRODUCT_IMAGE_FALLBACK);
    expect(hasProductImage("   ")).toBe(false);
  });

  it("does not route SVG placeholders through image resizing", () => {
    expect(getProductImageUrl("/placeholder-product.svg")).toBe(
      PRODUCT_IMAGE_FALLBACK,
    );
    expect(getProductImageUrl("https://cdn.example.com/product.svg?version=1")).toBe(
      "https://cdn.example.com/product.svg?version=1",
    );
  });

  it("omits responsive candidates when the source is missing or vector-only", () => {
    const variants = [
      { descriptor: "400w", width: 400, height: 400, fit: "contain" as const },
      { descriptor: "600w", width: 600, height: 600, fit: "contain" as const },
    ];

    expect(getProductImageSrcSet(null, variants)).toBe("");
    expect(getProductImageSrcSet(PRODUCT_IMAGE_FALLBACK, variants)).toBe("");
  });

  it("rebuilds responsive candidates from pre-optimized product image URLs", () => {
    const srcset = getProductImageSrcSet(
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=1200,height=1200,quality=85,format=auto,fit=contain,sharpen=1/products/fish.webp",
      [
        {
          descriptor: "400w",
          width: 400,
          height: 400,
          quality: 80,
          format: "auto",
          fit: "contain",
        },
        {
          descriptor: "600w",
          width: 600,
          height: 600,
          quality: 85,
          format: "auto",
          fit: "contain",
        },
      ],
    );

    expect(srcset.match(/\/cdn-cgi\/image\//g)).toHaveLength(2);
    expect(srcset).toContain("width=400");
    expect(srcset).toContain("width=600");
    expect(srcset).not.toContain("width=1200");
    expect(srcset).toContain("/products/fish.webp 400w");
    expect(srcset).toContain("/products/fish.webp 600w");
  });
});
