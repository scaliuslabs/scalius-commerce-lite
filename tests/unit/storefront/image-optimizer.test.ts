import { describe, expect, it } from "vitest";
import { getOptimizedImageUrl } from "../../../packages/shared/src/image-optimizer";

const cdnBase = "https://cloud.scalius.com";

describe("storefront image optimization URLs", () => {
  it("routes absolute CDN images through Cloudflare Image Resizing", () => {
    const optimized = getOptimizedImageUrl(
      "https://cloud.scalius.com/pages/combo-offer.webp",
      { width: 1280, height: 640, quality: 85, format: "auto", fit: "cover" },
      { cdnBase, isDev: false },
    );

    expect(optimized).toBe(
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=1280,height=640,quality=85,format=auto,fit=cover,sharpen=1/pages/combo-offer.webp",
    );
  });

  it("resolves bare R2 keys to the CDN before optimizing", () => {
    const optimized = getOptimizedImageUrl(
      "pages/combo-offer.webp",
      { width: 1280, height: 640, quality: 85, format: "auto", fit: "cover" },
      { cdnBase, isDev: false },
    );

    expect(optimized).toContain("https://cloud.scalius.com/cdn-cgi/image/");
    expect(optimized).toContain("/pages/combo-offer.webp");
  });

  it("does not double-wrap an already optimized image", () => {
    const optimized =
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400/image.webp";

    expect(
      getOptimizedImageUrl(optimized, undefined, { cdnBase, isDev: false }),
    ).toBe(optimized);
  });

  it("skips Cloudflare transforms in development", () => {
    expect(
      getOptimizedImageUrl("pages/combo-offer.webp", undefined, {
        cdnBase,
        isDev: true,
      }),
    ).toBe("https://cloud.scalius.com/pages/combo-offer.webp");
  });
});
