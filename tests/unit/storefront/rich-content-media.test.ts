import { describe, expect, it } from "vitest";
import {
  optimizeCssImageUrls,
  optimizeRichContentImages,
} from "../../../apps/storefront/src/lib/rich-content-media";

const hero = "https://cloud.scalius.com/media/media_hero1234.jpg/2400.webp";
const photo = "https://cloud.scalius.com/media/media_photo123.png/1200.webp";

describe("rich content images", () => {
  it("serves renditions with srcset for optimized images", () => {
    const optimized = optimizeRichContentImages(`<img src="${photo}" alt="Freeform">`);

    expect(optimized).toContain('src="https://cloud.scalius.com/media/media_photo123.png/640.webp"');
    expect(optimized).toContain("media_photo123.png/160.webp 160w");
    expect(optimized).toContain("media_photo123.png/1200.webp 1200w");
    expect(optimized).toContain('loading="lazy"');
    expect(optimized).toContain('alt="Freeform"');
  });

  it("marks the first priority image eager and normalizes stale loading attributes", () => {
    const html = `<section><img src="${hero}" loading="lazy" fetchpriority="low" decoding="sync" alt="Hero"><img src="${photo}" alt="Secondary"></section>`;

    const optimized = optimizeRichContentImages(html, { priority: true });

    expect(optimized).toContain('src="https://cloud.scalius.com/media/media_hero1234.jpg/960.webp"');
    expect(optimized).toContain('sizes="100vw"');
    expect(optimized).toContain('loading="eager"');
    expect(optimized.match(/fetchpriority=/g)).toHaveLength(1);
    expect(optimized).toContain('fetchpriority="high"');
    expect(optimized).toContain('decoding="async"');
    expect(optimized).toContain('loading="lazy"');
  });

  it("leaves images without renditions untouched", () => {
    for (const html of [
      '<img src="https://cloud.scalius.com/media/legacy.jpg" alt="Legacy">',
      '<img src="https://cloud.scalius.com/cms/logo.svg" alt="Logo">',
      '<img src="https://images.example.org/photo.jpg" alt="External">',
    ]) {
      expect(optimizeRichContentImages(html)).toBe(html);
    }
  });

  it("maps picture source candidates to renditions while preserving descriptors", () => {
    const html = `<picture><source media="(min-width: 768px)" srcset="${hero} 1200w, ${hero} 2x"><img src="https://images.example.org/photo.jpg" alt="Hero"></picture>`;

    const optimized = optimizeRichContentImages(html);

    expect(optimized).toContain(
      'srcset="https://cloud.scalius.com/media/media_hero1234.jpg/1600.webp 1200w, https://cloud.scalius.com/media/media_hero1234.jpg/1600.webp 2x"',
    );
  });

  it("serves a large rendition for CSS backgrounds without touching fonts", () => {
    const css = [
      `.hero { background-image: url('${hero}'); }`,
      "@font-face { src: url('https://cloud.scalius.com/fonts/site.woff2'); }",
    ].join("\n");

    const optimized = optimizeCssImageUrls(css);

    expect(optimized).toContain(
      'background-image: url("https://cloud.scalius.com/media/media_hero1234.jpg/1600.webp")',
    );
    expect(optimized).toContain("src: url('https://cloud.scalius.com/fonts/site.woff2')");
    expect(optimizeRichContentImages(`<section style="background-image:url(${hero})">Hero</section>`))
      .toContain('background-image:url("https://cloud.scalius.com/media/media_hero1234.jpg/1600.webp")');
  });
});
