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

  it("optimizes picture source srcset candidates while preserving descriptors", () => {
    const html = [
      "<picture>",
      '<source media="(min-width: 768px)" srcset="https://cloud.scalius.com/widgets/hero-large.webp 1200w, https://cloud.scalius.com/widgets/hero-large@2x.webp 2x">',
      '<img src="https://cloud.scalius.com/widgets/hero.webp" alt="Hero">',
      "</picture>",
    ].join("");

    const optimized = optimizeRichContentImages(html);

    expect(optimized).toContain(
      'srcset="https://cloud.scalius.com/cdn-cgi/image/',
    );
    expect(optimized).toContain(" 1200w");
    expect(optimized).toContain(" 2x");
    expect(optimized).not.toContain(
      'srcset="https://cloud.scalius.com/widgets/',
    );
  });

  it("marks the first priority widget image as eager with larger candidates", () => {
    const html =
      '<section><img src="https://cloud.scalius.com/widgets/hero.jpg" alt="Hero"><img src="https://cloud.scalius.com/widgets/secondary.jpg" alt="Secondary"></section>';

    const optimized = optimizeRichContentImages(html, { priority: true });

    expect(optimized).toContain("width=1280");
    expect(optimized).toContain(" 1920w");
    expect(optimized).toContain('sizes="100vw"');
    expect(optimized).toContain('loading="eager"');
    expect(optimized).toContain('fetchpriority="high"');
    expect(optimized).toContain('loading="lazy"');
  });

  it("keeps rich content responsive image variants width-only", () => {
    const html =
      '<img src="https://cloud.scalius.com/widgets/freeform-photo.jpg" alt="Freeform">';

    const optimized = optimizeRichContentImages(html);

    expect(optimized).toContain("width=600");
    expect(optimized).toContain("width=1200");
    expect(optimized).not.toContain("height=600");
  });

  it("normalizes stale image loading attributes", () => {
    const html =
      '<img src="https://cloud.scalius.com/widgets/hero.jpg" loading="lazy" fetchpriority="low" decoding="sync" alt="Hero">';

    const optimized = optimizeRichContentImages(html, { priority: true });

    expect(optimized).toContain('loading="eager"');
    expect(optimized).toContain('fetchpriority="high"');
    expect(optimized).toContain('decoding="async"');
    expect(optimized).not.toContain('fetchpriority="low"');
    expect(optimized.match(/fetchpriority=/g)).toHaveLength(1);
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

  it("does not route SVG assets through Cloudflare image resizing", () => {
    const html = '<img src="https://cloud.scalius.com/widgets/logo.svg" alt="Logo">';
    const css = ".logo { background-image: url('https://cloud.scalius.com/widgets/logo.svg'); }";

    const optimizedHtml = optimizeRichContentImages(html);
    expect(optimizedHtml).not.toContain("/cdn-cgi/image/");
    expect(optimizedHtml).not.toContain("srcset=");
    expect(optimizeCssImageUrls(css)).not.toContain("/cdn-cgi/image/");
  });
});
