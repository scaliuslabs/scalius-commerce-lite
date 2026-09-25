import { describe, expect, it } from "vitest";
import {
  mediaImageSrcSet,
  mediaImageUrl,
  mediaOriginalUrl,
  isUnrenderedMediaOriginal,
  mediaVariantWidths,
} from "./media-variants";

const master = "https://cdn.example.com/media/media_abc123.jpg/1200.webp";

describe("mediaVariantWidths", () => {
  it("steps by at most 1.2x up to 960", () => {
    const widths = mediaVariantWidths(1600);
    for (let i = 1; i < widths.length - 1; i += 1) expect(widths[i]! / widths[i - 1]!).toBeLessThanOrEqual(1.2);
    expect(widths.at(-2)).toBe(960);
  });

  it("never upscales and caps the master rendition", () => {
    expect(mediaVariantWidths(1200)).toEqual([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1200]);
    expect(mediaVariantWidths(1600)).toEqual([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1600]);
    expect(mediaVariantWidths(6000)).toEqual([144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1600, 2400]);
    expect(mediaVariantWidths(300)).toEqual([144, 172, 206, 247, 296, 300]);
    expect(mediaVariantWidths(120)).toEqual([120]);
    expect(mediaVariantWidths(0)).toEqual([]);
    expect(mediaVariantWidths(Number.NaN)).toEqual([]);
  });
});

describe("rendition URLs", () => {
  it("derives every rendition from the published master URL", () => {
    expect(mediaImageSrcSet(master)).toBe([
      "https://cdn.example.com/media/media_abc123.jpg/144.webp 144w",
      "https://cdn.example.com/media/media_abc123.jpg/172.webp 172w",
      "https://cdn.example.com/media/media_abc123.jpg/206.webp 206w",
      "https://cdn.example.com/media/media_abc123.jpg/247.webp 247w",
      "https://cdn.example.com/media/media_abc123.jpg/296.webp 296w",
      "https://cdn.example.com/media/media_abc123.jpg/355.webp 355w",
      "https://cdn.example.com/media/media_abc123.jpg/426.webp 426w",
      "https://cdn.example.com/media/media_abc123.jpg/511.webp 511w",
      "https://cdn.example.com/media/media_abc123.jpg/613.webp 613w",
      "https://cdn.example.com/media/media_abc123.jpg/735.webp 735w",
      "https://cdn.example.com/media/media_abc123.jpg/882.webp 882w",
      "https://cdn.example.com/media/media_abc123.jpg/960.webp 960w",
      "https://cdn.example.com/media/media_abc123.jpg/1200.webp 1200w",
    ].join(", "));
  });

  it("picks the smallest rendition covering the requested width", () => {
    expect(mediaImageUrl(master, 96)).toBe("https://cdn.example.com/media/media_abc123.jpg/144.webp");
    expect(mediaImageUrl(master, 230)).toBe("https://cdn.example.com/media/media_abc123.jpg/247.webp");
    expect(mediaImageUrl(master, 330)).toBe("https://cdn.example.com/media/media_abc123.jpg/355.webp");
    expect(mediaImageUrl(master, 600)).toBe("https://cdn.example.com/media/media_abc123.jpg/613.webp");
    expect(mediaImageUrl(master, 1600)).toBe(master);
  });

  it("keeps query strings and works with bare object keys", () => {
    expect(mediaImageUrl("media/a1b2c3d4.png/640.webp?v=2", 300)).toBe("media/a1b2c3d4.png/355.webp?v=2");
    expect(mediaOriginalUrl("media/a1b2c3d4.png/640.webp?v=2")).toBe("media/a1b2c3d4.png?v=2");
  });

  it("serves images without renditions untouched", () => {
    for (const url of [
      "https://cdn.example.com/media/media_abc123.jpg",
      "https://images.example.org/photos/pic.jpg/800.webp",
      "/placeholder-product.svg",
      "https://cdn.example.com/media/media_abc123.jpg/9999.webp",
    ]) {
      expect(mediaImageUrl(url, 320)).toBe(url);
      expect(mediaImageSrcSet(url)).toBe("");
      expect(mediaOriginalUrl(url)).toBe(url);
    }
  });

  it("maps a rendition back to the original upload", () => {
    expect(mediaOriginalUrl(master)).toBe("https://cdn.example.com/media/media_abc123.jpg");
  });

  it("names our own raster uploads served without renditions, and nothing else", () => {
    expect(isUnrenderedMediaOriginal("https://cdn.example.com/media/media_abc123.jpg")).toBe(true);
    expect(isUnrenderedMediaOriginal("media/a1b2c3d4.PNG?v=2")).toBe(true);
    // Older nested keys (imports, the audit's legacy rows) are ours too.
    expect(isUnrenderedMediaOriginal("http://localhost:9031/api/v1/media/media/legacy/p006.jpg")).toBe(true);
    expect(isUnrenderedMediaOriginal(master)).toBe(false);
    expect(isUnrenderedMediaOriginal("https://cdn.example.com/media/logo.svg")).toBe(false);
    expect(isUnrenderedMediaOriginal("https://images.example.org/photos/pic.jpg")).toBe(false);
    expect(isUnrenderedMediaOriginal("https://cdn.example.com/media/media_abc123.jpg/9999.webp")).toBe(false);
    expect(isUnrenderedMediaOriginal("")).toBe(false);
  });
});
