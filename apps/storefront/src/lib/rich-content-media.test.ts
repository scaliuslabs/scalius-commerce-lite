import { describe, expect, it } from "vitest";
import { demoteRichContentH1, optimizeRichContentImages } from "./rich-content-media";

describe("demoteRichContentH1", () => {
  it("turns merchant H1s into H2s and leaves other headings alone", () => {
    expect(demoteRichContentH1('<h1 class="x">VAPORESSO XROS 6 Mini</h1><h2>Specs</h2><H1>Box</H1>'))
      .toBe('<h2 class="x">VAPORESSO XROS 6 Mini</h2><h2>Specs</h2><h2>Box</h2>');
  });

  it("does not touch lookalike tags or text", () => {
    expect(demoteRichContentH1("<h10>x</h10><p>&lt;h1&gt;</p>")).toBe("<h10>x</h10><p>&lt;h1&gt;</p>");
  });
});

describe("optimizeRichContentImages", () => {
  const CDN = "https://cdn.example.com";

  it("rewrites our images with renditions to a srcset and loads them lazily", () => {
    const html = optimizeRichContentImages(`<p><img src="${CDN}/media/media_photo001.jpg/1600.webp" alt="Bag"></p>`);
    expect(html).toContain(`src="${CDN}/media/media_photo001.jpg/735.webp"`);
    expect(html).toContain(`${CDN}/media/media_photo001.jpg/960.webp 960w`);
    expect(html).toContain('loading="lazy" decoding="async"');
    expect(html).toContain('alt="Bag"');
  });

  it("loads an external image lazily and off the main thread, keeping its exact source", () => {
    const src = "https://images.unsplash.com/photo-1?ixlib=rb-4.0.3&amp;w=1920&amp;h=1280&amp;q=80";
    const html = optimizeRichContentImages(`<img src="${src}" loading="eager" fetchpriority="high" alt="Desk">`);
    expect(html).toBe(`<img alt="Desk" src="${src}" width="1920" height="1280" loading="lazy" decoding="async">`);
  });

  it("keeps the merchant's own size, and adds none it cannot know", () => {
    expect(optimizeRichContentImages('<img width="600" height="400" src="https://example.org/a.jpg?w=1920&h=1280">'))
      .toBe('<img width="600" height="400" src="https://example.org/a.jpg?w=1920&h=1280" loading="lazy" decoding="async">');
    expect(optimizeRichContentImages("<img src='https://example.org/a.jpg?w=1920'>"))
      .toBe(`<img src='https://example.org/a.jpg?w=1920' loading="lazy" decoding="async">`);
  });

  it("gives an original of ours without renditions the same lazy loading", () => {
    expect(optimizeRichContentImages(`<img src="${CDN}/media/media_legacy01.jpg">`))
      .toBe(`<img src="${CDN}/media/media_legacy01.jpg" loading="lazy" decoding="async">`);
  });

  it("keeps the first image eager and high priority on priority content", () => {
    const html = optimizeRichContentImages(
      '<img src="https://example.org/hero.jpg"><img src="https://example.org/second.jpg">',
      { priority: true },
    );
    expect(html).toBe(
      '<img src="https://example.org/hero.jpg" loading="eager" decoding="async" fetchpriority="high">' +
        '<img src="https://example.org/second.jpg" loading="lazy" decoding="async">',
    );
  });

  it("leaves data URIs and tags without a source alone", () => {
    expect(optimizeRichContentImages('<img src="data:image/png;base64,AAAA"><img alt="x">'))
      .toBe('<img src="data:image/png;base64,AAAA"><img alt="x">');
  });
});
