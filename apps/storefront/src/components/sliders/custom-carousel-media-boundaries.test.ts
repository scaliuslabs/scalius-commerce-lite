import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "CustomCarousel.astro"),
  "utf8",
);
const homepageProductRailSource = readFileSync(
  resolve(import.meta.dirname, "../collection2.astro"),
  "utf8",
);

describe("homepage carousel media boundaries", () => {
  it("requests only the hero source for the active viewport", () => {
    expect(source).toContain('type === "desktop" ? "(min-width: 768px)"');
    expect(source).toContain('"(max-width: 767px)"');
    expect(source).toContain("<picture");
    expect(source).toContain("srcset={index === 0 ? source : undefined}");
    expect(source).toContain("data-srcset={index === 0 ? undefined : source}");
    expect(source).toContain("src={transparentPixel}");
  });

  it("retains the active first slide's LCP priority and fixed dimensions", () => {
    expect(source).toContain('loading={index === 0 ? "eager" : "lazy"}');
    expect(source).toContain('fetchpriority={index === 0 ? "high" : "auto"}');
    expect(source).toContain("width={presentation.width}");
    expect(source).toContain("height={height}");
    expect(source).toContain("getHeroSlideObjectPosition(focalPoint)");
    expect(source).toMatch(
      /type === "desktop"\s*\?\s*index === 0\s*\?\s*90\s*:\s*80\s*:\s*index === 0\s*\?\s*75\s*:\s*70/,
    );
    expect(source).not.toContain('type === "desktop" ? (index === 0 ? 75');
  });

  it("reserves high image priority for the hero during the critical load", () => {
    expect(homepageProductRailSource).not.toContain("priority={index === 0}");
  });

  it("uses full touch targets without inflating the visible carousel dots", () => {
    expect(source).toContain(
      'class="group flex h-11 w-11 items-center justify-center rounded-full"',
    );
    expect(source).toContain("data-nav-indicator");
    expect(source).toContain('aria-current={index === 0 ? "true" : undefined}');
    expect(source).toContain("w-11 h-11");
  });

  it("warms later slides just in time and tears timers down on navigation", () => {
    expect(source).toContain("async prepareSlide(index: number)");
    expect(source).toContain("Math.max(6_000, this.interval - 2_000)");
    expect(source).toContain("source[data-srcset]");
    expect(source).toContain('document.addEventListener("astro:before-swap"');
    expect(source).toContain("carousel.__carouselController?.dispose()");
    expect(source).toContain("this.resizeObserver?.disconnect()");
    expect(source).toContain("Math.max(8_000, this.interval)");
    expect(source).toContain("if (this.initialTimer) clearTimeout(this.initialTimer)");
  });
});
