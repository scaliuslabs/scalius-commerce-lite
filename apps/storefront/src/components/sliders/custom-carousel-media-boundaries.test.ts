import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "CustomCarousel.astro"),
  "utf8",
);

describe("homepage carousel media boundaries", () => {
  it("requests only the hero source for the active viewport", () => {
    expect(source).toContain('type === "desktop" ? "(min-width: 768px)"');
    expect(source).toContain('"(max-width: 767px)"');
    expect(source).toContain("<picture");
    expect(source).toContain(
      "srcset={index === 0 ? source : undefined}",
    );
    expect(source).toContain("data-srcset={index === 0 ? undefined : source}");
    expect(source).toContain("src={transparentPixel}");
  });

  it("retains the active first slide's LCP priority and fixed dimensions", () => {
    expect(source).toContain('loading={index === 0 ? "eager" : "lazy"}');
    expect(source).toContain('fetchpriority={index === 0 ? "high" : "auto"}');
    expect(source).toContain("width={presentation.width}");
    expect(source).toContain("height={height}");
    expect(source).toContain("getHeroSlideObjectPosition(focalPoint)");
  });

  it("warms later slides just in time and tears timers down on navigation", () => {
    expect(source).toContain("async prepareSlide(index: number)");
    expect(source).toContain("this.interval - 1000");
    expect(source).toContain("source[data-srcset]");
    expect(source).toContain('document.addEventListener("astro:before-swap"');
    expect(source).toContain("carousel.__carouselController?.dispose()");
    expect(source).toContain("this.resizeObserver?.disconnect()");
  });
});
