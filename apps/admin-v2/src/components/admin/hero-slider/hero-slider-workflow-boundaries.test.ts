import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const containerSource = readFileSync(
  resolve(import.meta.dirname, "HeroSliderContainer.tsx"),
  "utf8",
);
const tabSource = readFileSync(
  resolve(import.meta.dirname, "SliderTab.tsx"),
  "utf8",
);
const carouselSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../storefront/src/components/sliders/CustomCarousel.astro",
  ),
  "utf8",
);

describe("hero slider workflow boundaries", () => {
  it("uses one explicit revision-guarded save instead of debounced field writes", () => {
    expect(containerSource).not.toContain("useDebouncedCallback");
    expect(containerSource).toContain("expectedRevision: draft.revision");
    expect(containerSource).toContain("readHeroSliderRevisionConflict");
    expect(containerSource).toContain("UnsavedChangesGuard");
    expect(tabSource).toContain("Save changes");
    expect(tabSource).toContain("Discard");
    expect(tabSource).toContain("Load latest");
  });

  it("renders intentionally unlinked slides without fake hash navigation", () => {
    expect(carouselSource).not.toContain('href={image.link || "#"}');
    expect(carouselSource).toContain('const SlideFrame = image.link ? "a" : "div"');
    expect(carouselSource).toContain("prefers-reduced-motion: reduce");
  });
});
