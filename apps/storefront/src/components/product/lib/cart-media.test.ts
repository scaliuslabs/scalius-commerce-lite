import { describe, expect, it } from "vitest";
import { resolveVariantCartMedia } from "./cart-media";

describe("resolveVariantCartMedia", () => {
  const productFallback = {
    imageUrl: "https://media.example.test/product.webp",
    imageMediaId: "med_product",
  };

  it("uses the selected SKU's authoritative URL and stable Media identity", () => {
    expect(resolveVariantCartMedia({
      imageUrl: "https://media.example.test/red.webp",
      imageMediaId: "med_red",
    }, productFallback)).toEqual({
      image: "https://media.example.test/red.webp",
      imageMediaId: "med_red",
    });
  });

  it("keeps URL and identity paired when a malformed SKU snapshot is incomplete", () => {
    expect(resolveVariantCartMedia({
      imageUrl: "https://media.example.test/unpaired.webp",
      imageMediaId: null,
    }, productFallback)).toEqual({
      image: "https://media.example.test/product.webp",
      imageMediaId: "med_product",
    });
  });

  it("still permits an image-only fallback when no stable Media identity exists", () => {
    expect(resolveVariantCartMedia({
      imageUrl: null,
      imageMediaId: null,
    }, {
      imageUrl: "/images/product.webp",
      imageMediaId: null,
    })).toEqual({ image: "/images/product.webp" });
  });
});
