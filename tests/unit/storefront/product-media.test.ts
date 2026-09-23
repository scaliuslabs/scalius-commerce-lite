import { describe, expect, it } from "vitest";
import {
  getProductImageSrcSet,
  getProductImageUrl,
  hasProductImage,
  PRODUCT_IMAGE_FALLBACK,
} from "../../../apps/storefront/src/lib/product-media";

const master = "https://cloud.scalius.com/media/media_fish1234.jpg/1600.webp";

describe("storefront product media helpers", () => {
  it("uses the canonical product placeholder when no image is present", () => {
    expect(getProductImageUrl(null, 480)).toBe(PRODUCT_IMAGE_FALLBACK);
    expect(getProductImageUrl("   ", 480)).toBe(PRODUCT_IMAGE_FALLBACK);
    expect(hasProductImage("   ")).toBe(false);
    expect(getProductImageSrcSet(null)).toBeUndefined();
  });

  it("serves images without renditions untouched", () => {
    for (const url of [
      "https://cdn.example.com/product.svg?version=1",
      "https://cloud.scalius.com/media/media_fish1234.jpg",
    ]) {
      expect(getProductImageUrl(url, 480)).toBe(url);
      expect(getProductImageSrcSet(url)).toBeUndefined();
    }
  });

  it("picks the rendition for a slot and offers every rendition to srcset", () => {
    expect(getProductImageUrl(master, 96)).toBe(
      "https://cloud.scalius.com/media/media_fish1234.jpg/160.webp",
    );
    expect(getProductImageUrl(master, 600)).toBe(
      "https://cloud.scalius.com/media/media_fish1234.jpg/640.webp",
    );
    expect(getProductImageSrcSet(master)?.split(", ").map((entry) => entry.split(" ")[1]))
      .toEqual(["160w", "320w", "480w", "640w", "960w", "1600w"]);
  });
});
