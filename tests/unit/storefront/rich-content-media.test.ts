import { describe, expect, it } from "vitest";
import { getOptimizedImageUrl } from "../../../packages/shared/src/image-optimizer";
import {
  optimizeCssImageUrls,
  optimizeRichContentImages,
} from "../../../apps/storefront/src/lib/rich-content-media";

describe("rich content image optimization behavior", () => {
  it("canonicalizes configured alias URLs through the shared optimizer", () => {
    const optimized = getOptimizedImageUrl(
      "https://old-cdn.example.com/cms/banner.jpg",
      { width: 600, quality: 85, format: "auto", fit: "scale-down" },
      {
        cdnBase: "https://cdn.example.com",
        cdnHosts: ["cdn.example.com"],
        cdnHostAliases: ["old-cdn.example.com"],
        isDev: false,
      },
    );

    expect(optimized).toBe(
      "https://cdn.example.com/cdn-cgi/image/onerror=redirect,width=600,height=600,quality=85,format=auto,fit=scale-down,sharpen=1/cms/banner.jpg",
    );
  });

  it("optimizes inline background image URLs in rich HTML", () => {
    const html =
      '<section style="background-image:url(https://cloud.scalius.com/widgets/hero.jpg)">Hero</section>';

    expect(optimizeRichContentImages(html)).toContain(
      'background-image:url("https://cloud.scalius.com/cdn-cgi/image/',
    );
  });

  it("optimizes widget CSS url() images without rewriting fonts", () => {
    const css = [
      ".hero { background-image: url('https://cloud.scalius.com/widgets/bg.webp'); }",
      "@font-face { src: url('https://cloud.scalius.com/fonts/site.woff2'); }",
    ].join("\n");

    const optimized = optimizeCssImageUrls(css);

    expect(optimized).toContain(
      'background-image: url("https://cloud.scalius.com/cdn-cgi/image/',
    );
    expect(optimized).toContain(
      "src: url('https://cloud.scalius.com/fonts/site.woff2')",
    );
  });
});
