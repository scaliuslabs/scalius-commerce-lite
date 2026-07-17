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
const rowSource = readFileSync(
  resolve(import.meta.dirname, "SlideRow.tsx"),
  "utf8",
);
const focalPointEditorSource = readFileSync(
  resolve(import.meta.dirname, "HeroFocalPointEditor.tsx"),
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

  it("previews each viewport with the shared storefront source ratio", () => {
    expect(tabSource).toContain("HERO_SLIDE_PRESENTATION[type]");
    expect(rowSource).toContain("HERO_SLIDE_PRESENTATION[type]");
    expect(rowSource).toContain("presentation.width} / ${presentation.height}");
    expect(rowSource).not.toContain("aspect-16/5");
    expect(carouselSource).toContain("HERO_SLIDE_PRESENTATION[type]");
    expect(carouselSource).not.toContain('type === "desktop" ? 1300 : 640');
  });

  it("keeps merchant crop focus consistent from the editor to Cloudflare delivery", () => {
    expect(rowSource).toContain("HeroFocalPointEditor");
    expect(rowSource).toContain("getHeroSlideObjectPosition(image.focalPoint)");
    expect(focalPointEditorSource).toContain("Click the subject that must stay visible.");
    expect(focalPointEditorSource).toContain('type="range"');
    expect(focalPointEditorSource).toContain("HERO_SLIDE_DEFAULT_FOCAL_POINT");
    expect(carouselSource).toContain("getHeroSlideCloudflareGravity(focalPoint)");
    expect(carouselSource).toContain("getHeroSlideObjectPosition(focalPoint)");
  });
});
