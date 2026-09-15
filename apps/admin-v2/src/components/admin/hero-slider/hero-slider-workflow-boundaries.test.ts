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
const sortableSlideSource = readFileSync(
  resolve(import.meta.dirname, "SortableSlide.tsx"),
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
  it("keeps the page title visible while the workspace loads", () => {
    expect(containerSource).toContain(
      '<h1 className="text-2xl font-semibold tracking-tight">Homepage hero</h1>',
    );
    expect(containerSource).toContain('aria-busy="true"');
  });

  it("uses one explicit revision-guarded save instead of debounced field writes", () => {
    expect(containerSource).not.toContain("useDebouncedCallback");
    expect(containerSource).toContain("expectedRevision: draft.revision");
    expect(containerSource).toContain("readHeroSliderRevisionConflict");
    expect(containerSource).toContain("UnsavedChangesGuard");
    expect(tabSource).toContain("Save changes");
    expect(tabSource).toContain("Discard");
    expect(tabSource).toContain("Load latest");
  });

  it("shows save actions only while the active hero has work to preserve", () => {
    expect(tabSource).toContain(
      "{dirty || saving ? (",
    );
    expect(tabSource).toContain(
      'className="sticky bottom-3 z-20 flex min-w-0 items-center justify-between gap-2',
    );
    expect(tabSource).toContain('className="flex shrink-0 items-center gap-1 sm:gap-2"');
    expect(tabSource).toContain('<span className="sm:hidden">Save</span>');
    expect(tabSource).toContain("{saving ? \"Saving…\" : \"Unsaved changes\"}");
    expect(tabSource).toContain(
      "{slider.images.length}/{HERO_SLIDE_LIMIT} slides",
    );
    expect(tabSource).not.toContain("All changes saved");
    expect(containerSource).toContain(
      "Manage separate desktop and mobile homepage banners.",
    );
    expect(containerSource).not.toContain("All changes saved");
  });

  it("keeps hero editing controls touchable without loosening desktop density", () => {
    expect(containerSource).toContain(
      'className="h-11 gap-2 px-3 sm:h-7"',
    );
    expect(tabSource).toContain('className="min-h-11 sm:min-h-9"');
    expect(tabSource).toContain(
      'className="min-h-11 px-2 sm:min-h-9 sm:px-3"',
    );
    expect(rowSource).toContain('className="h-11 text-sm md:h-8"');
    expect(rowSource).toContain("md:h-8 md:w-8");
    expect(focalPointEditorSource).toContain(
      "h-11 gap-1 rounded-md",
    );
    expect(sortableSlideSource).toContain("w-11 shrink-0");
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
    expect(rowSource).toContain("getHeroSlideImageTransform(type, image.focalPoint");
    expect(carouselSource).toContain("getHeroSlideImageTransform(type, focalPoint");
    expect(carouselSource).toContain("getHeroSlideObjectPosition(focalPoint)");
  });
});
